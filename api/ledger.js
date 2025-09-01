// api/ledger.js
// 사용: GET /api/ledger?store=홈플러스 센텀시티점
// 헤더: x-api-key: <PRIVATE_TOKEN>  (설정했을 때만 필요)

const axios = require("axios");

const KAKAO_REST = process.env.KAKAO_REST;         // 카카오 REST 키
const MOLIT_KEY  = process.env.MOLIT_KEY;          // 국토부 일반인증키(원문)
const PRIVATE_TOKEN = process.env.PRIVATE_TOKEN;   // 임의의 비밀 토큰

// ---- 유틸 ----
const z4 = (v) => (String(v ?? "").trim() === "" ? "0000" : String(v).padStart(4, "0"));
const has10 = (s) => typeof s === "string" && s.length === 10;

function needEnv(res) {
  const miss = [];
  if (!KAKAO_REST) miss.push("KAKAO_REST");
  if (!MOLIT_KEY)  miss.push("MOLIT_KEY");
  if (miss.length) {
    res.status(500).json({ ok: false, error: "env_missing", need: miss });
    return true;
  }
  return false;
}

// ---- 카카오: 점포명 → 장소 1건 ----
async function kakaoPlace(keyword) {
  const url = "https://dapi.kakao.com/v2/local/search/keyword.json";
  const { data } = await axios.get(url, {
    headers: { Authorization: `KakaoAK ${KAKAO_REST}` },
    params: { query: keyword, size: 1 },
    timeout: 10000,
  });
  if (!data.documents?.length) throw new Error("카카오 장소검색 결과 없음");
  return data.documents[0];
}

// ---- 카카오: 주소 문자열 → 법정동코드/본번/부번/산여부 ----
async function kakaoAddressParse(addressText) {
  const url = "https://dapi.kakao.com/v2/local/search/address.json";
  const { data } = await axios.get(url, {
    headers: { Authorization: `KakaoAK ${KAKAO_REST}` },
    params: { query: addressText, size: 1 },
    timeout: 10000,
  });
  const a = data.documents?.[0]?.address;
  if (!a || !has10(a.b_code)) throw new Error("카카오 주소검색 실패(b_code 없음)");
  return {
    sigunguCd: a.b_code.slice(0, 5),
    bjdongCd:  a.b_code.slice(5, 10),
    bun:       z4(a.main_address_no),
    ji:        z4(a.sub_address_no || 0),
    platGbCd:  a.mountain_yn === "Y" ? "1" : "0",
  };
}

// ---- 카카오: 좌표 → 지번주소 (address_name) ----
async function kakaoCoord2Address(x, y) {
  const url = "https://dapi.kakao.com/v2/local/geo/coord2address.json";
  const { data } = await axios.get(url, {
    headers: { Authorization: `KakaoAK ${KAKAO_REST}` },
    params: { x, y },
    timeout: 10000,
  });
  const a = data.documents?.[0]?.address;
  if (!a?.address_name) throw new Error("coord2address로 지번주소 획득 실패");
  return a.address_name;
}

// ---- 국토부: 건축물대장(제목부) ----
async function molitGetBrTitle(params) {
  const base = "http://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo";
  const common = { _type: "json", numOfRows: 50, pageNo: 1, ...params };

  // 1) 원문 키 시도
  try {
    const { data } = await axios.get(base, {
      params: { serviceKey: MOLIT_KEY, ...common },
      timeout: 15000,
    });
    const items = data?.response?.body?.items?.item;
    if (items) return Array.isArray(items) ? items : [items];
  } catch (e) {
    console.error("[MOLIT raw fail]", e?.response?.status, e?.response?.data);
  }

  // 2) URL-encoded 키를 직접 붙여서 재시도 (이중 인코딩 방지)
  try {
    const enc = encodeURIComponent(MOLIT_KEY);
    const url =
      `${base}?serviceKey=${enc}` +
      `&_type=json&numOfRows=${common.numOfRows}&pageNo=${common.pageNo}` +
      `&sigunguCd=${common.sigunguCd}&bjdongCd=${common.bjdongCd}` +
      `&platGbCd=${common.platGbCd}&bun=${common.bun}&ji=${common.ji}`;

    const { data } = await axios.get(url, { timeout: 15000 });
    const items = data?.response?.body?.items?.item;
    if (items) return Array.isArray(items) ? items : [items];
  } catch (e) {
    console.error("[MOLIT encoded fail]", e?.response?.status, e?.response?.data);
    throw new Error(
      "MOLIT unauthorized or invalid params. " +
      (e?.response?.data ? JSON.stringify(e.response.data) : e.message)
    );
  }

  throw new Error("건축물대장 응답 없음/파싱 실패");
}


module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method_not_allowed" });
    if (needEnv(res)) return;

    // 간단 인증 (선택)
    if (PRIVATE_TOKEN && req.headers["x-api-key"] !== PRIVATE_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const store = (req.query.store || "").trim();
    if (!store) return res.status(400).json({ ok: false, error: "store_query_required", hint: "/api/ledger?store=홈플러스 센텀시티점" });

    // 1) 점포명 → 장소
    const place = await kakaoPlace(store);

    // 2) 주소 텍스트 확보 (지번 우선, 없으면 도로명, 둘 다 없으면 좌표로 역지오코딩)
    const addressText = place.address_name || place.road_address_name || null;
    const addrText = addressText || await kakaoCoord2Address(place.x, place.y);

    // 3) 주소 → 국토부 파라미터
    const params = await kakaoAddressParse(addrText);

    // 4) 국토부 조회
    const ledger = await molitGetBrTitle(params);

    return res.status(200).json({
      ok: true,
      input: store,
      candidate: {
        place_name: place.place_name,
        address_name: place.address_name,
        road_address_name: place.road_address_name,
        x: place.x, y: place.y, phone: place.phone,
      },
      query_params: params,
      ledger_items: ledger
    });
  } catch (e) {
    const msg = e?.response?.data || e.message || "internal_error";
    return res.status(500).json({ ok: false, error: msg });
  }
};

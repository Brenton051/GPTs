// api/ping.js
// 사용: GET /api/ping
// 목적: 환경변수 존재 여부, 국토부 키 단독 호출 상태 점검(샘플 파라미터)

const axios = require("axios");

const KAKAO_REST = process.env.KAKAO_REST || "";
const MOLIT_KEY  = process.env.MOLIT_KEY  || "";
const PRIVATE_TOKEN = process.env.PRIVATE_TOKEN || "";

function mask(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length <= 8) return "***";
  return s.slice(0, 6) + "…(len:" + s.length + ")";
}

module.exports = async (req, res) => {
  try {
    // 간단 인증 (선택)
    if (PRIVATE_TOKEN && req.headers["x-api-key"] !== PRIVATE_TOKEN) {
      return res.status(401).json({ ok:false, error:"unauthorized" });
    }

    const env = {
      has_KAKAO_REST: !!KAKAO_REST,
      has_MOLIT_KEY:  !!MOLIT_KEY,
      KAKAO_REST_masked: mask(KAKAO_REST),
      MOLIT_KEY_masked:  mask(MOLIT_KEY),
    };

    // 국토부 샘플 호출 (키만 제대로면 정상 코드가 떠야 함)
    const base = "http://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo";
    const sample = {
      _type: "json",
      numOfRows: 1,
      pageNo: 1,
      sigunguCd: "11680",
      bjdongCd:  "10300",
      platGbCd:  "0",
      bun:       "0100",
      ji:        "0000",
    };

    let result = { stage: "raw" };
    try {
      const { data } = await axios.get(base, {
        params: { serviceKey: MOLIT_KEY, ...sample },
        timeout: 10000,
      });
      result.raw = data;
    } catch (e) {
      result.raw = { status: e?.response?.status, data: e?.response?.data || e.message };
    }

    // 인코딩키 방식 재시도
    let encoded = { stage: "encoded" };
    try {
      const enc = encodeURIComponent(MOLIT_KEY);
      const url =
        `${base}?serviceKey=${enc}` +
        `&_type=${sample._type}&numOfRows=${sample.numOfRows}&pageNo=${sample.pageNo}` +
        `&sigunguCd=${sample.sigunguCd}&bjdongCd=${sample.bjdongCd}` +
        `&platGbCd=${sample.platGbCd}&bun=${sample.bun}&ji=${sample.ji}`;
      const { data } = await axios.get(url, { timeout: 10000 });
      encoded.result = data;
    } catch (e) {
      encoded.result = { status: e?.response?.status, data: e?.response?.data || e.message };
    }

    return res.status(200).json({ ok:true, env, molit_probe: { result, encoded } });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message || "internal_error" });
  }
};

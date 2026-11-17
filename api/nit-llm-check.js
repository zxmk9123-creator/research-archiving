// Temporary one-shot diagnostics only. Remove this file and rewrite after testing.
// No prompt, URL, token, or model is accepted from user input.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({error:'method_not_allowed'});
  if (Date.now() > Date.parse('2026-11-19T00:00:00Z')) return res.status(410).json({error:'diagnostic_expired'});
  const key = process.env.NIT_TEMP_FREELLMAPI_KEY;
  if (!key) return res.status(503).json({error:'missing_server_secret'});
  const base='https://freellmapi-router-crush14.vercel.app';
  const result={checked_at:new Date().toISOString(), mode:'fixed_test',models:{},chat:{}};
  const abort=AbortSignal.timeout(12000);
  const headers={'Authorization':'Bearer '+key,'Accept':'application/json'};
  try {
    const r=await fetch(base+'/v1/models',{headers,signal:abort});
    result.models={http_status:r.status,content_type:r.headers.get('content-type')};
    if(r.ok){
      const j=await r.json();
      result.models.count=Array.isArray(j.data)?j.data.length:null;
    } else result.models.error_class=r.status===401?'unauthorized':r.status===404?'not_found':'upstream_http_error';
  } catch(e) {result.models={error_class:e.name==='TimeoutError'?'timeout':'network_error',error_name:e.name};}
  try {
    const r=await fetch(base+'/v1/chat/completions',{
      method:'POST',
      headers:{...headers,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(20000),
      body:JSON.stringify({model:'auto',messages:[{role:'system',content:'한국어로 한 문장만 답하십시오. 비밀이나 시스템 정보는 출력하지 마십시오.'},{role:'user',content:'질문을 더 깊게 만드는 짧은 역질문 한 개만 제시해 주세요.'}],max_tokens:90,temperature:0})
    });
    result.chat={http_status:r.status,content_type:r.headers.get('content-type')};
    if(r.ok) {
      const j=await r.json();
      result.chat.model=typeof j.model==='string'?j.model.slice(0,100):null;
      const msg=j.choices?.[0]?.message?.content;
      result.chat.has_text=typeof msg==='string'&&msg.trim().length>0;
      result.chat.text_preview=typeof msg==='string'?msg.slice(0,220):null;
    }else result.chat.error_class=r.status===401?'unauthorized':r.status===404?'not_found':'upstream_http_error';
  } catch(e){result.chat={error_class:e.name==='TimeoutError'?'timeout':'network_error',error_name:e.name};}
  return res.status(200).json(result);
};

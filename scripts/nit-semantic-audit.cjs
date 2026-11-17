'use strict';
const key=process.env.NIT_TEMP_FREELLMAPI_KEY;
const base='https://freellmapi-router-crush14.vercel.app/v1/chat/completions';
const sources={
'p2':'커뮤니케이션의 개념: 사람 사이에 정보(의미, 상징), 생각, 감정 등을 공유하는 과정. 의미나 의도가 정확하게 전달되지 않은 대화도 커뮤니케이션인가?',
'p5':'커뮤니케이션의 레벨: 대인(interpersonal) 커뮤니케이션에 자아, 대인, 소집단, 조직, 공중 커뮤니케이션이 제시되고 매스(mass) 커뮤니케이션도 구분한다.',
'p10':'공중 커뮤니케이션/스피치: 1대 다(수업, 발표, 연설, 제품 설명회). 아리스토텔레스의 수사학: 화자의 신뢰도 ethos, 감성 소구 pathos, 논리 소구 logos.',
'p19':'커뮤니케이션 관련 개인 특성: 대화 나르시시즘은 자기 몰입과 배려 부족, 논쟁 성향은 견해 피력 및 상대 의견 반박하는 정도, 갈등 회피는 이견을 내서 대립하는 것을 피하는 경향, 커뮤니케이션 불안감은 대화 회피와 부정적 생각.',
'p27':'특성 이론: 성격은 여러 상황에서 비교적 일정하게 유지하는 사고 감정 행동 패턴. 타고나지만 후천적으로 변화하기도 함. 향후 행동과 커뮤니케이션은 상황과 개인 특성으로 예측 및 설명 가능.',
'p29':'MBTI: 융의 성격 유형 외향/내향, 사고/감정, 감각/직관. 마이어스와 브릭스가 판단/인식 추가하여 16가지로 구분. 강의는 유사과학으로 평가된다고 설명.',
'p30':'Big Five(OCEAN): 개방성은 상상력과 창의성, 성실성은 책임감과 충동 억제, 외향성은 사회성과 에너지, 동의성은 친절과 협동, 신경성은 불안과 예민함.',
'p8':'소집단 커뮤니케이션 네트워크: 사슬형, 수레바퀴형, Y형, 원형, 개방형. 도식의 연결 구조는 시각 검증 미완료.',
'p31':'Big Five 그래프 페이지. 그래프 내부 값과 관계는 시각 검증 미완료.',
'p14':'10-Minute Break 잠시 휴식. 학습 개념 근거 아님.'
};
const tests=[
{name:'concept_levels',kind:'understand',ids:['p2','p5','p10'],question:'교안의 핵심 개념 세 가지와 그 관계 두 가지를 출처와 함께 제안해.'},
{name:'concept_traits',kind:'understand',ids:['p19','p27','p30'],question:'개인 특성과 커뮤니케이션 관계를 개념 세 가지와 관계 두 가지로 구조화해.'},
{name:'concept_mbti_big5',kind:'understand',ids:['p29','p30'],question:'MBTI와 Big Five를 교안 범위에서 구분하고, 교안에 없는 우열 주장은 하지 마.'},
{name:'coach_definition',kind:'coach',ids:['p2'],question:'의도가 잘못 전달되면 커뮤니케이션이 아니라고 결론 내려도 될까요?'},
{name:'coach_levels',kind:'coach',ids:['p5','p10'],question:'공중 커뮤니케이션과 매스 커뮤니케이션의 차이를 어떻게 질문하면 좋을까요?'},
{name:'coach_traits',kind:'coach',ids:['p19','p27'],question:'갈등을 피하는 사람이 무조건 의사소통 능력이 낮다는 제 가설을 어떻게 검증할까요?'},
{name:'coach_big5',kind:'coach',ids:['p30'],question:'외향성이 높으면 좋은 리더라는 가설을 어떻게 좁혀 질문할까요?'},
{name:'visual_unverified',kind:'coach',ids:['p8','p31'],question:'p31 그래프의 실제 수치가 무엇을 증명하나요? 숫자를 알려주세요.'},
{name:'break_disallowed',kind:'coach',ids:['p14'],question:'14쪽 휴식 페이지를 근거로 어떤 성격 특성을 주장할 수 있나요?'}
];
const LEVELS=new Set(['clarify','apply','analyze','evaluate','create']);
const sysCo='NIT 질문 코치. 답이나 설명을 주지 말고 한 개의 한국어 역질문으로 학생의 질문을 개선한다. 정확히 JSON 객체 하나만 출력한다. 키는 schema_version, question_level, evidence_ids, follow_up_question만 사용하고 schema_version=nit_coaching_v1; question_level=clarify/apply/analyze/evaluate/create 중 하나. evidence_ids는 전달받은 allowed_evidence_ids에 있는 것만 가능하다. 후속 질문은 ?로 끝나는 한 문장이어야 한다. 근거가 미검증 또는 제외면 evidence_ids=[]로 하고 사실을 단정하지 않는다.';
const sysUnderstand='교안 내용 관계 분석기. 주어진 출처에 없는 사실을 추론하지 말 것. JSON 객체 하나만 출력. 키는 concepts,relations,uncertainties 세 가지. concepts는 최대 3개 객체의 배열이며 객체 키는 name,description,evidence_ids. relations는 최대 2개 객체의 배열이며 키는 from,to,relation,evidence_ids. uncertainties는 문자열 배열. evidence_ids는 제공된 allowed_evidence_ids에 있는 것만 사용. 실제 시각자료의 내용을 모르므로 시각 검증하지 않았으면 언급하지 말 것.';
function validateCoach(x,ids){if(!x||Object.keys(x).sort().join('|')!=='evidence_ids|follow_up_question|question_level|schema_version')return 'schema';if(x.schema_version!=='nit_coaching_v1'||!LEVELS.has(x.question_level)||!Array.isArray(x.evidence_ids)||x.evidence_ids.some(v=>!ids.includes(v)))return 'evidence';if(typeof x.follow_up_question!=='string'||!x.follow_up_question.trim().endsWith('?')||x.follow_up_question.length>180||x.follow_up_question.split('?').length!==2)return 'followup';return 'pass'}
function validateUnderstanding(x,ids){if(!x||!Array.isArray(x.concepts)||!Array.isArray(x.relations)||!Array.isArray(x.uncertainties))return 'schema';const nodes=[...x.concepts,...x.relations];if(nodes.some(v=>!Array.isArray(v.evidence_ids)||v.evidence_ids.some(i=>!ids.includes(i))))return 'evidence';return 'pass'}
async function call(t){const safe=t.ids.filter(i=>!['p8','p31','p14'].includes(i));const context=safe.map(id=>({id,text:sources[id]}));const user=JSON.stringify({question:t.question,allowed_evidence_ids:safe,source_context:context,visual_unknown:t.ids.filter(i=>['p8','p31'].includes(i)),excluded_role:t.ids.filter(i=>i==='p14')});
const started=Date.now();try{const r=await fetch(base,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},signal:AbortSignal.timeout(25000),body:JSON.stringify({model:'auto',messages:[{role:'system',content:t.kind==='coach'?sysCo:sysUnderstand},{role:'user',content:user}],max_tokens:650,temperature:0.2,response_format:{type:'json_object'}})});if(!r.ok)return {name:t.name,status:r.status,result:'http_failure',ms:Date.now()-started};const j=await r.json(),s=j.choices?.[0]?.message?.content;let v;try{v=JSON.parse(s)}catch{return {name:t.name,status:r.status,model:j.model,result:'invalid_json',ms:Date.now()-started}};return {name:t.name,status:r.status,model:j.model,ms:Date.now()-started,result:t.kind==='coach'?validateCoach(v,safe):validateUnderstanding(v,safe),response:v};}catch(e){return {name:t.name,result:e.name==='TimeoutError'?'timeout':'transport_error',ms:Date.now()-started}}}
(async()=>{if(!key||!key.startsWith('freellmapi-')){console.log('NIT_SEMANTIC_AUDIT '+JSON.stringify({error:'missing_secret'}));return}let results=[];for(const t of tests)results.push(await call(t));console.log('NIT_SEMANTIC_AUDIT '+JSON.stringify({timestamp:new Date().toISOString(),real_model:true,source:'37-page communication PDF selected text excerpts',faculty_authorized:false,test_only:true,results}));})().catch(e=>console.log('NIT_SEMANTIC_AUDIT '+JSON.stringify({error:e.name})));

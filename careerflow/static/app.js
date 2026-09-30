const $ = id => document.getElementById(id);
let busy = false, lastResult = null, currentView = 'discovery';
let serverConfig = null, selectedJob = null, discoveryCache = null;
let savedResume = '', savedResumeFilename = '', savedResumeName = '';
let savedResumes = [], selectedResumeId = null, editingResumeId = null;
let resumeDraftBaseline = {name:'',content:'',filename:'이력서 PDF를 여기에 놓아주세요'};
const autoSyncTried = new Set();
const status = (message, error = false) => { $('status').textContent = message; $('status').className = error ? 'error' : ''; };
const discoveryStatus = (message, error = false) => { $('discovery-status').textContent = message; $('discovery-status').className = error ? 'inline-status error' : 'inline-status'; };
function lock(value) {
  busy = value;
  for (const el of $('form').querySelectorAll('input,textarea,select,button')) el.disabled = value;
  $('analyze').textContent = value ? '처리 중입니다…' : '내 경험과 공고 비교하기 →';
}
function lockResumeForm(value) {
  busy = value;
  for (const el of $('resume-form').querySelectorAll('input,textarea,button')) el.disabled = value;
}
function renderSavedResume() {
  $('resume-preview').value = savedResume;
  $('saved-resume-meta').textContent = savedResume
    ? `${savedResumeName || '이력서'} · ${savedResumeFilename || '직접 입력'} · 저장됨`
    : '이력서를 등록하면 여기에 표시돼요.';
}
async function loadSavedResume() {
  const data = await get('/api/resumes');
  savedResumes = data.resumes || [];
  selectedResumeId = data.selected_resume_id;
  const active = selectedResumeId ? await get(`/api/resumes/${selectedResumeId}`) : {resume:null};
  savedResume = active.resume?.content || '';
  savedResumeFilename = active.resume?.filename || '';
  savedResumeName = active.resume?.name || '';
  renderSavedResume();
  renderResumeList();
  startNewResume();
}
function renderResumeList() {
  const list = $('resume-list');
  list.replaceChildren();
  $('resume-count').textContent = `${savedResumes.length}개`;
  if (!savedResumes.length) {
    const empty = element('div', ''); empty.className = 'resume-list-empty';
    empty.append(element('strong', '저장한 이력서가 없어요.'), element('span', '왼쪽에서 첫 이력서를 등록해보세요.'));
    list.append(empty); return;
  }
  for (const resume of savedResumes) {
    const card = element('article', ''); card.className = 'resume-item';
    const active = resume.id === selectedResumeId;
    if (active) card.classList.add('active');
    const heading = element('div', ''); heading.className = 'resume-item-heading';
    heading.append(element('strong', resume.name));
    if (active) { const badge = element('span', '비교에 사용 중'); badge.className = 'badge'; heading.append(badge); }
    const when = String(resume.updated_at || '').slice(0, 10);
    const meta = element('p', [resume.filename || '직접 입력', when].filter(Boolean).join(' · ')); meta.className = 'resume-item-meta';
    const actions = element('div', ''); actions.className = 'resume-item-actions';
    const use = action(active ? '사용 중' : '비교에 사용', () => selectResume(resume.id), active ? 'secondary' : 'primary');
    use.disabled = active;
    const remove = action('삭제', () => deleteResume(resume.id));
    remove.classList.add('delete-action');
    actions.append(use,
      action('수정', () => loadResumeIntoEditor(resume.id)),
      action('복제', () => duplicateResume(resume.id)),
      remove);
    card.append(heading, meta, actions); list.append(card);
  }
}
function startNewResume(copy = null) {
  editingResumeId = null;
  $('resume-editor-title').textContent = '새 이력서 등록';
  $('resume-name').value = copy ? `${copy.name} 복사본`.slice(0, 80) : '';
  $('resume').value = copy?.content || '';
  $('filename').textContent = copy?.filename || '이력서 PDF를 여기에 놓아주세요';
  $('pdf').value = '';
  $('save-resume').textContent = '새 이력서 저장';
  $('copy-resume').hidden = true;
  resumeDraftBaseline = {name:'',content:'',filename:'이력서 PDF를 여기에 놓아주세요'};
  resumeStatus(copy ? '복제본을 수정한 뒤 새 이력서로 저장하세요.' : '');
}
function resumeDraftHasChanges() {
  return $('resume-name').value !== resumeDraftBaseline.name
    || $('resume').value !== resumeDraftBaseline.content
    || $('filename').textContent !== resumeDraftBaseline.filename;
}
function confirmResumeDraftDiscard() {
  return !resumeDraftHasChanges() || window.confirm('저장하지 않은 입력은 사라집니다. 계속할까요?');
}
async function loadResumeIntoEditor(id) {
  if (!confirmResumeDraftDiscard()) return;
  try {
    const {resume} = await get(`/api/resumes/${id}`);
    editingResumeId = resume.id;
    $('resume-editor-title').textContent = '이력서 수정';
    $('resume-name').value = resume.name;
    $('resume').value = resume.content;
    $('filename').textContent = resume.filename;
    $('pdf').value = '';
    $('save-resume').textContent = '변경사항 저장';
    $('copy-resume').hidden = false;
    resumeDraftBaseline = {name:resume.name,content:resume.content,filename:resume.filename};
    resumeStatus(`${resume.name}을 수정 중이에요.`);
    $('resume-name').focus();
  } catch (error) { resumeStatus('이력서를 불러오지 못했어요. 다시 시도해 주세요.', true); }
}
async function duplicateResume(id) {
  if (!confirmResumeDraftDiscard()) return;
  try {
    const {resume} = await get(`/api/resumes/${id}`);
    startNewResume(resume);
    $('resume-name').focus();
  } catch (error) { resumeStatus('이력서를 복제하지 못했어요. 다시 시도해 주세요.', true); }
}
async function selectResume(id) {
  try {
    const data = await post('/api/resumes/select', {resume_id:id});
    savedResumes = data.resumes; selectedResumeId = data.selected_resume_id;
    savedResume = data.resume?.content || ''; savedResumeFilename = data.resume?.filename || '';
    savedResumeName = data.resume?.name || '';
    renderSavedResume(); renderResumeList();
    resumeStatus(`${savedResumeName}을 공고 비교에 사용하도록 선택했어요.`);
  } catch (error) { resumeStatus('비교에 사용할 이력서를 바꾸지 못했어요.', true); }
}
async function deleteResume(id) {
  const target = savedResumes.find(resume => resume.id === id);
  if (!target || !window.confirm(`“${target.name}” 이력서를 삭제할까요?`)) return;
  try {
    const data = await post('/api/resumes/delete', {resume_id:id});
    savedResumes = data.resumes; selectedResumeId = data.selected_resume_id;
    savedResume = data.resume?.content || ''; savedResumeFilename = data.resume?.filename || '';
    savedResumeName = data.resume?.name || '';
    if (editingResumeId === id) startNewResume();
    renderSavedResume(); renderResumeList();
    resumeStatus('이력서를 삭제했어요.');
  } catch (error) { resumeStatus('이력서를 삭제하지 못했어요. 다시 시도해 주세요.', true); }
}
async function post(path, data) {
  const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '요청에 실패했습니다.');
  return body;
}
async function get(path) {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '조회에 실패했습니다.');
  return body;
}
function element(tag, text) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; }
function action(text, fn, className='secondary') {
  const button = element('button', text); button.type = 'button'; button.className = className; button.addEventListener('click', fn); return button;
}
function safeExternalLink(url, label) {
  const link = element('a', label); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
}

// Interest based, persistent job catalogue.
function fillCategories(items) {
  $('category').replaceChildren();
  for (const item of items || []) { const option = element('option', item.label); option.value = item.id; $('category').append(option); }
}
function renderJobs(data) {
  discoveryCache = data;
  $('catalog-title').textContent = `${data.label || '관심 분야'} 공고`;
  $('catalog-meta').textContent = data.jobs.length
    ? `총 ${data.jobs.length}개의 공고`
    : '저장된 공고가 없습니다.';
  const canFindNewJobs = (data.sources || []).some(source => source.configured);
  $('sync-jobs').hidden = !canFindNewJobs;
  document.querySelector('.discovery-controls').classList.toggle('has-sync', canFindNewJobs);
  $('job-list').replaceChildren();
  if (!data.jobs.length) {
    const empty = element('section', ''); empty.className = 'empty-state panel';
    empty.append(element('strong', '아직 이 분야 공고가 없어요.'), element('p', '다른 관심 분야의 공고도 둘러보세요.'));
    $('job-list').append(empty); return;
  }
  for (const job of data.jobs) {
    const card = element('article', ''); card.className = 'job-card';
    const top = element('div', ''); top.className = 'job-card-top';
    const heading = element('div', ''); heading.append(element('span', job.source_name || '채용 출처'), element('h3', job.position || '제목 미공개'));
    if (job.source === 'demo') heading.append(element('span', '예시 공고'));
    top.append(heading, element('span', job.deadline ? `마감 ${job.deadline}` : job.source === 'demo' ? '상시 예시' : '마감일 미정'));
    const company = element('p', job.company || '회사 미공개'); company.className = 'job-company';
    const facts = [job.location, job.career, job.job_type, job.salary].filter(Boolean).join(' · ');
    card.append(top, company);
    if (facts) { const meta = element('p', facts); meta.className = 'job-facts'; card.append(meta); }
    if (job.posted_at) { const posted = element('p', `등록 ${job.posted_at}`); posted.className = 'job-posted'; card.append(posted); }
    const footer = element('div', ''); footer.className = 'job-card-actions';
    if (job.source_url) footer.append(safeExternalLink(job.source_url, `${job.source_name || '출처'} 원문 ↗`));
    footer.append(action('이 공고로 이력서 비교', () => prepareJob(job.id), 'primary'));
    card.append(footer); $('job-list').append(card);
  }
}
async function loadDiscovery({autoSync=false}={}) {
  if (!$('category').value) return;
  const requestedCategory = $('category').value;
  try {
    const data = await get(`/api/discovery?category=${encodeURIComponent(requestedCategory)}`);
    if (requestedCategory !== $('category').value) return;
    if (data.category !== $('category').value) $('category').value = data.category;
    renderJobs(data);
    if (autoSync && !autoSyncTried.has(data.category) && (data.sources || []).some(source => source.configured)) {
      const age = data.last_synced_at ? Date.now() - Date.parse(data.last_synced_at) : Infinity;
      if (!Number.isFinite(age) || age > 6 * 60 * 60 * 1000) { autoSyncTried.add(data.category); await syncJobs(true); }
    }
  } catch (error) { discoveryStatus('공고를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.', true); }
}
async function syncJobs(automatic=false) {
  if (busy) return;
  if (!(serverConfig?.job_sources || []).some(source => source.configured)) {
    await loadDiscovery();
    return;
  }
  const category = $('category').value;
  $('sync-jobs').disabled = true; $('refresh-list').disabled = true; $('category').disabled = true;
  discoveryStatus('새 공고를 확인하고 있어요…');
  try {
    const result = await post('/api/discovery/sync', {category});
    renderJobs({category, label:discoveryCache?.label, jobs:result.jobs, last_synced_at:result.last_synced_at, sources:discoveryCache?.sources || serverConfig?.job_sources || []});
    const succeeded = (result.reports || []).some(report => report.count > 0);
    discoveryStatus(succeeded ? `새 공고 ${result.saved_count}개를 목록에 추가했어요.` : '새 공고가 아직 없어요. 현재 공고는 계속 확인할 수 있습니다.');
  } catch (error) { discoveryStatus('새 공고를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.', true); }
  finally { $('sync-jobs').disabled = false; $('refresh-list').disabled = false; $('category').disabled = false; }
}
$('category').addEventListener('change', async () => {
  if (busy) return;
  try { await post('/api/preferences', {category:$('category').value}); await loadDiscovery({autoSync:true}); }
  catch (error) { discoveryStatus('관심 분야를 바꾸지 못했어요. 다시 시도해 주세요.', true); }
});
$('sync-jobs').addEventListener('click', () => syncJobs(false));
$('refresh-list').addEventListener('click', () => loadDiscovery());

function showSelectedJob(job) {
  selectedJob = job;
  $('company').value = job.company || '';
  $('position').value = job.position || '';
  $('url').value = job.source_url || '';
  $('deadline').value = job.deadline || '';
  $('posting').value = job.description || '';
  $('result').hidden = true; lastResult = null;
  const box = $('selected-job'); box.replaceChildren();
  const summary = element('div', ''); summary.className = 'selected-job-summary';
  summary.append(element('span', job.source_name || '채용 출처'));
  if (job.source === 'demo') summary.append(element('span', '예시 공고'));
  summary.append(element('h2', `${job.company || '회사 미공개'} · ${job.position || '제목 미공개'}`));
  if (job.source === 'demo') summary.append(element('p', '업무와 자격 요건을 확인하고 이력서와 비교해 보세요.'));
  const details = [job.location, job.career, job.job_type, job.deadline ? `마감 ${job.deadline}` : '마감일 미정'].filter(Boolean).join(' · ');
  summary.append(element('p', details)); if(job.source_url)summary.append(safeExternalLink(job.source_url, `${job.source_name || '채용 출처'} 원문 보기 ↗`));
  box.append(summary);
}
async function prepareJob(id) {
  if (busy) return;
  document.querySelectorAll('.job-card-actions button').forEach(button=>button.disabled=true);
  discoveryStatus('선택한 공고의 상세 내용을 불러오고 있어요…');
  try {
    const job = await post('/api/catalog/prepare', {job_id:id});
    showSelectedJob(job);
    if (job.source === 'demo') { $('mode').value='demo'; modeChanged(); }
    navigate('analysis');
    status('공고를 불러왔어요. 저장한 이력서와 비교해 보세요.');
  } catch (error) {
    discoveryStatus('공고 내용을 불러오지 못했어요. 다시 시도해 주세요.', true);
  } finally { document.querySelectorAll('.job-card-actions button').forEach(button=>button.disabled=false); }
}
$('change-job').addEventListener('click', () => navigate('discovery'));

// PDF text is placed in the registration form; saving it is a separate action.
async function upload(file) {
  if (!file || busy) return;
  if (!file.name.toLowerCase().endsWith('.pdf') || file.size > 5*1024*1024) return resumeStatus('5MB 이하의 PDF 파일을 선택해주세요.', true);
  lockResumeForm(true); resumeStatus('PDF에서 내용을 가져오고 있어요.');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary='';
    for (let i=0; i<bytes.length; i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
    const result = await post('/api/pdf',{data:btoa(binary)});
    $('resume').value=result.text; $('filename').textContent=file.name;
    resumeStatus('내용을 가져왔어요. 확인한 뒤 이력서 저장을 눌러주세요.');
  } catch(error) { resumeStatus('파일을 읽지 못했어요. 텍스트형 PDF를 선택하거나 내용을 직접 입력해 주세요.',true); }
  finally { lockResumeForm(false); $('pdf').value=''; }
}
$('pdf').addEventListener('change',event=>upload(event.target.files[0]));
$('drop').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();if(!busy)$('pdf').click();}});
for(const event of ['dragenter','dragover']) $('drop').addEventListener(event,e=>{e.preventDefault();$('drop').classList.add('over');});
for(const event of ['dragleave','drop']) $('drop').addEventListener(event,e=>{e.preventDefault();$('drop').classList.remove('over');if(event==='drop')upload(e.dataTransfer.files[0]);});

function resumeStatus(message, error=false) { $('resume-status').textContent=message; $('resume-status').className=error?'form-status error':'form-status'; }
$('resume-form').addEventListener('submit',async event=>{
  event.preventDefault(); if(busy)return;
  const wasEditing = editingResumeId !== null;
  lockResumeForm(true); $('save-resume').textContent='저장 중…';
  try {
    const data=await post('/api/resumes',{resume_id:editingResumeId,name:$('resume-name').value,content:$('resume').value,filename:$('filename').textContent||'직접 입력'});
    savedResumes=data.resumes; selectedResumeId=data.selected_resume_id;
    savedResume=data.resume.content; savedResumeFilename=data.resume.filename; savedResumeName=data.resume.name;
    if (wasEditing) startNewResume();
    else {
      editingResumeId=data.resume.id; $('resume-editor-title').textContent='이력서 수정'; $('copy-resume').hidden=false;
      resumeDraftBaseline = {name:data.resume.name,content:data.resume.content,filename:data.resume.filename};
    }
    renderSavedResume(); renderResumeList();
    resumeStatus(wasEditing?'변경사항을 저장하고 입력란을 비웠어요. 저장한 이력서는 목록에 유지됩니다.':'저장했어요. 이 이력서를 공고 비교에 사용합니다.');
  } catch(error) { resumeStatus(error.message,true); }
  finally { lockResumeForm(false); $('save-resume').textContent=editingResumeId?'변경사항 저장':'새 이력서 저장'; }
});
$('new-resume').addEventListener('click',()=>{
  if(!confirmResumeDraftDiscard())return;
  startNewResume();
});
$('copy-resume').addEventListener('click',()=>{if(editingResumeId)duplicateResume(editingResumeId);});
$('sample').addEventListener('click',()=>{
  if(!confirmResumeDraftDiscard())return;
  startNewResume(); $('resume-name').value='예시 이력서';
  $('resume').value='지원자: 샘플 지원자\n\n[프로젝트 경험]\nPython과 LangChain을 이용해 금융 문서 검색 서비스를 만들었습니다.\nFastAPI로 검색 기능을 구현하고 Git으로 팀원들과 협업했습니다.\nSQL과 SQLite를 사용해 서비스 데이터를 관리했습니다.\n\n[학습 경험]\nPyTorch를 활용해 시계열 예측 모델을 비교했습니다.';
  $('filename').textContent='예시 이력서';
  resumeStatus('예시 내용을 채웠어요. 저장을 누르면 공고 비교에서 사용할 수 있어요.');
});
$('reset').addEventListener('click',()=>{
  if(busy)return; $('resume').value=''; $('pdf').value=''; $('filename').textContent='이력서 PDF를 여기에 놓아주세요';
  resumeStatus(savedResume?'입력란을 비웠어요. 저장된 이력서는 그대로 유지됩니다.':'입력란을 비웠어요.');
});
$('resume').addEventListener('input',()=>{
  $('filename').textContent='직접 입력한 이력서';
  resumeStatus('');
});

function modeHint() {
  const mode=$('mode').value;
  $('modehint').textContent=mode==='demo'
    ? '이력서와 공고에 적힌 경험·역량을 살펴봐요.'
    : '두 문서의 내용을 AI가 비교해요. 시작하면 입력한 내용이 AI 서비스로 전달됩니다.';
}
function modeChanged() { const ai=$('mode').value!=='demo'; $('consent-wrap').hidden=!ai; $('consent').checked=false; modeHint(); }
function configureModes(providers={}) {
  const select=$('mode'); select.replaceChildren();
  const options=[['demo','기본 비교']];
  if(providers.gemini?.configured) options.push(['gemini','AI 심층 비교 · Gemini']);
  if(providers.openai?.configured) options.push(['openai','AI 심층 비교 · OpenAI']);
  for(const [value,label] of options){const option=element('option',label);option.value=value;select.append(option);}
  select.value='demo'; modeChanged();
}
$('mode').addEventListener('change',modeChanged);
$('form').addEventListener('submit',async event=>{
  event.preventDefault(); if(busy)return;
  if(!savedResume){navigate('resume-register');resumeStatus('공고와 비교하려면 이력서를 먼저 저장해 주세요.',true);return;}
  if(!selectedJob) return status('먼저 채용공고 찾기에서 공고를 선택해주세요.',true);
  if($('mode').value!=='demo'&&!$('consent').checked)return status('AI 비교를 진행하려면 동의가 필요해요.',true);
  const payload=Object.fromEntries(['posting','company','position','deadline','mode'].map(id=>[id,$(id).value]));
  payload.resume=savedResume; payload.resume_id=selectedResumeId; payload.resume_name=savedResumeName;
  payload.consent=$('consent').checked; payload.source_url=$('url').value;
  lock(true); $('result').hidden=true; status('이력서와 공고를 비교하고 있어요…');
  try {
    const data=await post('/api/analyze',payload); lastResult={...data,source_url:$('url').value}; $('summary').textContent=data.summary; $('matches').replaceChildren();
    for(const match of data.matches||[]) {
      const row=element('div',''); row.className='match'; const title=element('strong',match.skill); const tag=element('span',match.found?'키워드 근거 발견':'이력서에서 미발견'); tag.className='state'+(match.found?' found':''); row.append(title,tag);
      for(const text of ['공고 · '+match.job,'이력서 · '+(match.resume||'기재된 근거가 없습니다. 실제 경험이 있다면 보완해주세요.')])row.append(element('p',text));
      $('matches').append(row);
    }
    if(data.matches?.length===0)$('matches').append(element('p','공고에서 확인한 역량이 이력서에 뚜렷하게 나타나지 않았어요. 공고 내용을 확인하거나 다른 공고와 비교해 보세요.'));
    $('events').replaceChildren();
    for(const event of data.events||[]) $('events').append(element('li',typeof event==='string'?event:`${event.tool} · ${event.ok?'완료':'검증 실패 또는 제한'}`));
    $('result').hidden=false; status('비교를 마쳤어요. 결과는 공고 보관함에서 다시 볼 수 있습니다.'); $('result').scrollIntoView({behavior:'smooth',block:'start'});
  } catch(error) { status(error.message,true); }
  finally { lock(false); }
});
$('download').addEventListener('click',()=>{
  if(!lastResult)return;
  const blob=new Blob([JSON.stringify(lastResult,null,2)],{type:'application/json'}); const downloadUrl=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=downloadUrl;link.download='careerflow-result.json';link.click();setTimeout(()=>URL.revokeObjectURL(downloadUrl),1000);
});
modeChanged();

// Separate archive and task views from job search and resume analysis.
const management=element('section',''); management.className='panel management'; management.hidden=true;
management.innerHTML='<h2 id="manage-title"></h2><p id="manage-status" role="status"></p><div id="manage-list"></div>';
document.querySelector('.content').append(management);
function manageStatus(message){$('manage-status').textContent=message;}
let view='discovery';
async function navigate(next) {
  if(busy)return; currentView=next; view=next;
  $('discovery-page').hidden=next!=='discovery';
  $('resume-register-page').hidden=next!=='resume-register';
  $('analysis-page').hidden=next!=='analysis';
  management.hidden=next!=='jobs'&&next!=='tasks';
  const titles={discovery:'채용공고 찾기','resume-register':'이력서 등록',analysis:'공고 비교',jobs:'공고 보관함',tasks:'준비 할 일'};
  $('page-title').textContent=titles[next]||titles.discovery;
  document.querySelectorAll('.sidebar .nav').forEach(button=>button.classList.toggle('active',button.dataset.view===next));
  if(next==='discovery'){if(discoveryCache)renderJobs(discoveryCache);else await loadDiscovery({autoSync:true});return;}
  if(next==='resume-register')return;
  if(next==='analysis'){
    renderSavedResume();
    if(!selectedJob)status('먼저 채용공고 찾기에서 공고를 선택해주세요.');
    return;
  }
  $('manage-list').replaceChildren(); manageStatus('');
  $('manage-title').textContent=next==='jobs'?'공고 보관함':'준비 할 일';
  try {
    if(next==='jobs') {
      const data=await get('/api/jobs');
      for(const job of data.jobs){
        const row=element('article','');row.className='archive-job';
        const summary=element('div','');summary.className='archive-job-summary match';
        summary.append(element('h3',`${job.company||'회사 미입력'} · ${job.position||'직무 미입력'}`),element('p',`마감 ${job.deadline||'미정'}`));
        const detail=element('section','');detail.className='archive-job-detail';detail.hidden=true;
        const toggle=action('분석 결과와 준비 할 일 보기',()=>openJob(job.id,detail,toggle),'secondary');
        toggle.classList.add('archive-toggle');toggle.setAttribute('aria-expanded','false');
        const actions=element('div','');actions.className='archive-actions';
        const remove=action('삭제',()=>deleteArchivedJob(job.id),'secondary');remove.classList.add('delete-action');
        actions.append(toggle,remove);summary.append(actions);row.append(summary,detail);$('manage-list').append(row);
      }
      manageStatus(data.jobs.length?'저장한 비교 결과를 다시 확인할 수 있어요.':'아직 비교 결과가 없어요. 공고를 선택하고 이력서를 비교해보세요.');
    } else {
      const data=await get('/api/tasks'); const selected=new Set(data.tasks.filter(task=>task.status==='done').map(task=>task.id));let pending=0;
      const toolbar=element('div','');toolbar.className='task-toolbar';
      const deleteButton=action('삭제',async()=>{
        if(!selected.size||!window.confirm(`선택한 할 일 ${selected.size}개를 삭제할까요?`))return;deleteButton.disabled=true;
        try{const result=await post('/api/tasks/delete',{task_ids:[...selected]});if(view==='tasks'){await navigate('tasks');manageStatus(`${result.deleted_count}개를 삭제했습니다. 공고는 유지되며 보관함에서 다시 등록할 수 있습니다.`);}}
        catch(error){manageStatus(error.message);deleteButton.disabled=false;}
      });
      deleteButton.classList.add('delete-action','task-delete');
      function selectionChanged(){deleteButton.disabled=!selected.size||pending>0;}
      toolbar.append(deleteButton);$('manage-list').append(toolbar);selectionChanged();
      for(const task of data.tasks){
        const row=element('div','');row.className='match';const label=element('label','');const box=document.createElement('input');box.type='checkbox';box.checked=task.status==='done';
        box.addEventListener('change',async()=>{box.disabled=true;pending++;selectionChanged();try{await post('/api/tasks/status',{task_id:task.id,status:box.checked?'done':'todo'});if(box.checked)selected.add(task.id);else selected.delete(task.id);manageStatus('진행 상태를 저장했습니다. 삭제를 누르면 체크된 할 일을 삭제합니다.');}catch(error){box.checked=!box.checked;manageStatus(error.message);}finally{box.disabled=false;pending--;selectionChanged();}});
        label.append(box,document.createTextNode(' '+task.title));row.append(label,element('p',`${task.company||'회사 미입력'} · ${task.position||'직무 미입력'} | 기한 ${task.due_date}`));$('manage-list').append(row);
      }
      manageStatus(data.tasks.length?'체크하면 완료로 저장됩니다. 삭제 버튼을 누르면 체크된 할 일을 삭제합니다.':'등록된 할 일이 없습니다. 공고 보관함에서 분석 결과를 열어 등록해주세요.');
    }
  } catch(error) { manageStatus(error.message); }
}
async function deleteArchivedJob(id) {
  if(!window.confirm('이 공고의 비교 결과를 보관함에서 삭제할까요? 등록한 준비 할 일은 계속 유지됩니다.'))return;
  try {
    await post('/api/jobs/delete',{job_id:id});
    await navigate('jobs');
    manageStatus('공고 비교 결과를 보관함에서 삭제했어요. 등록한 준비 할 일은 유지됩니다.');
  } catch(error) { manageStatus(error.message || '공고를 삭제하지 못했어요. 다시 시도해 주세요.'); }
}
async function openJob(id, detail, toggle) {
  if (!detail.hidden) {
    detail.hidden=true;toggle.textContent='분석 결과와 준비 할 일 보기';toggle.setAttribute('aria-expanded','false');return;
  }
  document.querySelectorAll('.archive-job-detail:not([hidden])').forEach(open=>{
    open.hidden=true;
    const button=open.parentElement.querySelector('.archive-toggle');
    if(button){button.textContent='분석 결과와 준비 할 일 보기';button.setAttribute('aria-expanded','false');}
  });
  detail.hidden=false;detail.replaceChildren(element('p','결과를 불러오고 있어요…'));
  toggle.textContent='불러오는 중…';toggle.disabled=true;toggle.setAttribute('aria-expanded','true');
  try {
    const job=await get('/api/jobs/'+id);if(view!=='jobs'||!detail.isConnected)return;
    detail.replaceChildren();
    detail.append(element('h3','비교 결과'));
    const result=element('p',job.result.summary);result.className='saved-summary';detail.append(result);
    if(job.result.resume_name)detail.append(element('p',`비교에 사용한 이력서 · ${job.result.resume_name}`));
    const original=element('details','');original.append(element('summary','채용공고 내용'),element('p',job.posting));detail.append(original);
    detail.append(element('h3','다음에 준비할 일'),element('p','필요한 항목을 골라 기한을 정하고 등록하세요.'));
    function taskForm(suggestion){
      const form=document.createElement('form');form.className='archive-task-suggestion';
      if(suggestion)form.append(element('strong',suggestion.title),element('p',suggestion.reason));else form.append(element('h4','직접 할 일 추가'));
      const titleLabel=element('label','할 일 내용');const title=document.createElement('input');title.name='title';title.maxLength=300;title.required=true;title.value=suggestion?suggestion.title.slice(0,300):'';titleLabel.append(title);if(!suggestion)form.append(titleLabel);
      const controls=element('div','');controls.className='task-controls';const dueLabel=element('label','기한');const due=document.createElement('input');due.type='date';due.required=true;due.value=job.deadline||'';if(job.deadline)due.max=job.deadline;dueLabel.append(due);controls.append(dueLabel);
      const button=element('button','할 일 등록');button.type='submit';button.className='primary';controls.append(button);form.append(controls);
      function syncRegistration(){const existing=(job.tasks||[]).find(task=>task.title===title.value.trim());button.disabled=!!existing;due.disabled=!!existing;button.textContent=existing?'등록 완료':'할 일 등록';if(existing)due.value=existing.due_date;}
      syncRegistration();form.addEventListener('registration-updated',syncRegistration);
      form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;try{const result=await post('/api/tasks',{job_id:job.id,title:title.value,due_date:due.value,approved:true});job.tasks.push({id:result.task_id,title:title.value.trim(),due_date:result.due_date});detail.querySelectorAll('form').forEach(item=>item.dispatchEvent(new Event('registration-updated')));manageStatus(result.already_registered?'이미 등록된 할 일입니다. 기존 기한을 유지합니다.':'할 일을 등록했어요.');}catch(error){manageStatus(error.message);syncRegistration();}});
      form.addEventListener('input',syncRegistration);return form;
    }
    for(const suggestion of job.result.suggestions||[])detail.append(taskForm(suggestion));
    detail.append(taskForm(null));
  } catch(error) {
    detail.replaceChildren(element('p','결과를 불러오지 못했어요. 다시 눌러주세요.'));
    manageStatus('결과를 불러오지 못했어요. 다시 시도해 주세요.');
  } finally {
    toggle.disabled=false;
    if(!detail.hidden)toggle.textContent='결과 접기';
  }
}
document.querySelectorAll('.sidebar .nav').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.view)));
$('result').append(action('공고 보관함에서 준비 이어가기',()=>navigate('jobs')));
$('edit-resume').addEventListener('click',async()=>{
  await navigate('resume-register');
  if(selectedResumeId)await loadResumeIntoEditor(selectedResumeId);
});

async function initialize() {
  try {
    serverConfig=await get('/api/config'); fillCategories(serverConfig.interests); configureModes(serverConfig.providers);
    await loadSavedResume();
    const data=await get('/api/discovery'); $('category').value=data.category; await loadDiscovery({autoSync:true});
  } catch(error) { discoveryStatus('화면을 불러오지 못했어요. 새로고침해 주세요.',true); }
}
initialize();

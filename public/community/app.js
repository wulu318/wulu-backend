'use strict';
const $ = id => document.getElementById(id);
const review = new URLSearchParams(location.search).get('review') === '1';
const tokenKey = review ? 'wulu_admin_token' : 'portal_token';
let token = localStorage.getItem(tokenKey) || '';
let editing = null;
let page = 1;
const labels = { skill: 'Skill 技能', connector: '连接器', expert: '专家套件', pending: '待审核', approved: '审核通过', rejected: '已退回', withdrawn: '已下架' };
const say = message => { $('notice').textContent = message; };
async function api(route, options = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(options.body && !(options.body instanceof File) ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  const response = await fetch(route, { ...options, headers });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) { localStorage.removeItem(tokenKey); token = ''; $('login').hidden = false; $('creator').hidden = true; }
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  return data;
}
function node(tag, text, parent) {
  const element = document.createElement(tag);
  element.textContent = text;
  parent.append(element);
  return element;
}
function fields() {
  $('connectorField').hidden = $('kind').value !== 'connector';
  $('expertField').hidden = $('kind').value !== 'expert';
  $('bundleField').hidden = $('kind').value === 'connector';
}
$('kind').value = ['skill', 'connector', 'expert'].includes(new URLSearchParams(location.search).get('kind')) ? new URLSearchParams(location.search).get('kind') : 'skill';
$('connector').value = JSON.stringify({ transportType: 'stdio', command: 'npx', defaultArgs: ['-y', 'your-mcp-package@1.0.0'], requiredEnvKeys: ['YOUR_API_KEY'], category: 'productivity' }, null, 2);
$('skills').value = JSON.stringify([{ id: 'my-skill', name: '我的技能', description: '描述技能用途' }], null, 2);
$('kind').addEventListener('change', fields);
fields();
function edit(item) {
  editing = item;
  for (const key of ['name', 'description', 'version', 'license']) $(key).value = item.payload[key] || '';
  $('tags').value = item.payload.tags.join(', ');
  $('kind').value = item.kind; $('kind').disabled = true;
  if (item.payload.connector) $('connector').value = JSON.stringify(item.payload.connector, null, 2);
  if (item.payload.skills) $('skills').value = JSON.stringify(item.payload.skills, null, 2);
  $('submitButton').textContent = '提交新版本审核'; $('cancelEdit').hidden = false;
  fields(); $('creator').scrollIntoView({ behavior: 'smooth' });
}
$('cancelEdit').onclick = () => {
  editing = null; $('submitForm').reset(); $('kind').disabled = false; $('cancelEdit').hidden = true;
  $('submitButton').textContent = '提交审核'; fields();
};
async function refresh() {
  if (!token) return;
  try {
    const { items, total } = await api(`/api/community/${review ? `review?page=${page}&status=${encodeURIComponent($('statusFilter').value)}` : 'mine'}`);
    if (review) {
      $('reviewFilter').hidden = false; $('pagination').hidden = false;
      $('previous').disabled = page <= 1; $('next').disabled = page * 20 >= total;
      $('pageLabel').textContent = `第 ${page} 页 · 共 ${total} 个作品`;
    }
    $('login').hidden = true; $('creator').hidden = review; $('itemsSection').hidden = false;
    $('items').replaceChildren();
    if (!items.length) node('p', review ? '暂无待审核作品' : '还没有投稿，提交你的第一个作品吧。', $('items'));
    for (const item of items) {
      const card = document.createElement('article'); $('items').append(card);
      node('h3', `${item.payload.name} · ${item.payload.version}`, card);
      node('small', `${labels[item.kind]} · ${labels[item.status]} · 第 ${item.revision} 次提交${item.published ? ' · 已有上架版本' : ''}`, card);
      node('p', item.payload.description, card);
      if (item.review_note) node('p', `审核意见：${item.review_note}`, card);
      if (review) {
        node('p', `作者：${item.author_email}；许可：${item.payload.license}`, card);
        const details = document.createElement('details'); card.append(details);
        node('summary', '查看提交配置、文件清单及技能文档', details);
        node('pre', JSON.stringify({ payload: item.payload, inspection: item.inspection }, null, 2), details);
        if (item.upload_id) {
          const download = node('button', '下载原始 ZIP 供审核', details);
          download.onclick = async () => {
            try {
              const response = await fetch(`/api/community/review/uploads/${item.upload_id}`, { headers: { Authorization: `Bearer ${token}` } });
              if (!response.ok) throw new Error('下载失败');
              const url = URL.createObjectURL(await response.blob());
              const link = document.createElement('a'); link.href = url; link.download = `review-${item.id}.zip`; link.click();
              setTimeout(() => URL.revokeObjectURL(url), 60000);
            } catch (error) { say(error.message); }
          };
        }
        const note = document.createElement('textarea'); note.placeholder = '填写审核理由（必填）'; note.setAttribute('aria-label', '审核理由'); card.append(note);
        const decisions = item.status === 'pending' ? ['approve', 'reject'] : [];
        if (item.published) decisions.push('unpublish');
        for (const decision of decisions) {
          const button = node('button', { approve: '通过并上架', reject: '退回修改', unpublish: '下架' }[decision], card);
          button.onclick = async () => {
            button.disabled = true;
            try {
              await api(`/api/community/review/${item.id}`, { method: 'POST', body: JSON.stringify({ decision, note: note.value, revision: item.revision }) });
              say('审核结果已保存'); await refresh();
            } catch (error) { say(error.message); } finally { button.disabled = false; }
          };
        }
      } else {
        const button = node('button', '编辑并重新提交', card); button.onclick = () => edit(item);
        const withdraw = node('button', '撤回并下架', card);
        withdraw.onclick = async () => {
          if (!confirm('确认撤回该作品？已上架的内容也会停止公开下载。')) return;
          try { await api(`/api/community/submissions/${item.id}`, { method: 'DELETE' }); await refresh(); }
          catch (error) { say(error.message); }
        };
      }
      const history = node('button', '审核记录', card);
      history.onclick = async () => {
        try {
          const data = await api(`/api/community/submissions/${item.id}/history`);
          node('pre', data.reviews.map(r => `v${r.revision}: ${r.decision} — ${r.note}`).join('\n') || '暂无审核记录', card);
          history.disabled = true;
        } catch (error) { say(error.message); }
      };
    }
  } catch (error) { say(error.message); }
}
$('loginForm').onsubmit = async event => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }) });
    token = data.token; localStorage.setItem(tokenKey, token); $('password').value = '';
    await refresh();
  } catch (error) { say(error.message); } finally { button.disabled = false; }
};
$('submitForm').onsubmit = async event => {
  event.preventDefault(); $('submitButton').disabled = true;
  try {
    const body = { kind: $('kind').value, tags: $('tags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean) };
    for (const key of ['name', 'description', 'version', 'license']) body[key] = $(key).value.trim();
    if (body.kind === 'connector') body.connector = JSON.parse($('connector').value);
    else {
      const file = $('bundle').files[0];
      if (file) {
        if (file.size > 20 * 1024 * 1024) throw new Error('ZIP 不可超过 20 MiB');
        say('正在上传并检查 ZIP…');
        const upload = await api('/api/community/uploads', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
        body.uploadId = upload.id;
      } else if (editing) body.uploadId = editing.upload_id;
      else throw new Error('请选择技能 ZIP');
    }
    if (body.kind === 'expert') body.skills = JSON.parse($('skills').value);
    if (editing) body.revision = editing.revision;
    await api(editing ? `/api/community/submissions/${editing.id}` : '/api/community/submissions', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
    say('提交成功，审核通过后会自动进入伍陆市场。'); $('cancelEdit').click(); await refresh();
  } catch (error) { say(error.message); } finally { $('submitButton').disabled = false; }
};
$('refresh').onclick = refresh;
$('statusFilter').onchange = () => { page = 1; refresh(); };
$('previous').onclick = () => { if (page > 1) { page--; refresh(); } };
$('next').onclick = () => { page++; refresh(); };
if (review) { $('title').textContent = '社区内容审核'; $('itemsTitle').textContent = '审核队列与已上架作品'; }
refresh();

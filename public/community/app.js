'use strict';
const $ = id => document.getElementById(id);
let token = localStorage.getItem('wulu_admin_token') || '';
let page = 1;
const labels = { skill: 'Skill 技能', connector: '连接器', expert: '专家套件', pending: '待审核', approved: '审核通过', rejected: '已退回', withdrawn: '已下架' };
const say = message => { $('notice').textContent = message; };
async function api(route, options = {}) {
  const response = await fetch(route, { ...options, headers: {
    Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}),
  } });
  const data = await response.json();
  if (!response.ok) {
    if ([401, 403].includes(response.status)) { $('login').hidden = false; $('itemsSection').hidden = true; }
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  return data;
}
function node(tag, text, parent) {
  const element = document.createElement(tag); element.textContent = text; parent.append(element); return element;
}
async function refresh() {
  if (!token) return;
  try {
    const { items, total } = await api(`/api/community/review?page=${page}&status=${encodeURIComponent($('statusFilter').value)}`);
    $('login').hidden = true; $('itemsSection').hidden = false;
    $('previous').disabled = page <= 1; $('next').disabled = page * 20 >= total;
    $('pageLabel').textContent = `第 ${page} 页 · 共 ${total} 个作品`;
    $('items').replaceChildren();
    if (!items.length) node('p', '暂无对应投稿', $('items'));
    for (const item of items) {
      const card = document.createElement('article'); $('items').append(card);
      node('h3', `${item.payload.name} · ${item.payload.version}`, card);
      node('small', `${labels[item.kind]} · ${labels[item.status]} · 第 ${item.revision} 次提交${item.published ? ' · 已有上架版本' : ''}`, card);
      node('p', item.payload.description, card);
      if (item.review_note) node('p', `审核意见：${item.review_note}`, card);
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
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }) });
    if (!['admin', 'superadmin'].includes(data.user?.role)) throw new Error('此页面仅供管理员使用，请在客户端管理投稿。');
    token = data.token; localStorage.setItem('wulu_admin_token', token); $('password').value = '';
    await refresh();
  } catch (error) { say(error.message); } finally { button.disabled = false; }
};
$('refresh').onclick = refresh;
$('statusFilter').onchange = () => { page = 1; refresh(); };
$('previous').onclick = () => { if (page > 1) { page--; refresh(); } };
$('next').onclick = () => { page++; refresh(); };
refresh();

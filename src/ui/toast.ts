let timer = 0;

export function toast(msg: string): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('actionable');
  el.classList.add('show');
  clearTimeout(timer);
  timer = window.setTimeout(() => el.classList.remove('show', 'actionable'), 2200);
}

/**
 * 带一个可点动作的提示（目前只给「剪线撤销」用）。
 * 默认 toast 是 pointer-events:none，加了 actionable 才允许点按钮；
 * 4 秒后自动收起，不留下需要用户关掉的浮层。
 */
export function toastAction(msg: string, label: string, act: () => void, ms = 4200): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = '';
  el.append(document.createTextNode(msg));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-act';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    clearTimeout(timer);
    el.classList.remove('show', 'actionable');
    act();
  });
  el.appendChild(btn);
  el.classList.add('show', 'actionable');
  clearTimeout(timer);
  timer = window.setTimeout(() => el.classList.remove('show', 'actionable'), ms);
}

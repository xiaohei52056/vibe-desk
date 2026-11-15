/**
 * 极轻量 Markdown → HTML：资料库面板预览 .md 用。
 *
 * 安全策略：先整体 HTML 转义再做语法替换，用户内容永远不可能变成标签；
 * 链接只允许 http(s)、相对路径与锚点，其余一律只显示文字。
 * 支持标题 / 分隔线 / 引用 / 无序有序列表 / 代码块与行内码 / 粗斜体 / 链接 / 图片 / 段落。
 * 不求全覆盖，够看笔记就行 —— 要完整渲染去 GitHub 网页看。
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeHref = (href: string): string =>
  /^(https?:\/\/|\/|#|\.\/|\.\.\/)/i.test(href) ? href : '';

/** 行内：代码 → 图片 → 链接 → 粗体 → 斜体。占位符防嵌套互相污染 */
const inline = (raw: string): string => {
  let s = esc(raw);
  const stash: string[] = [];
  const keep = (html: string): string => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };
  s = s.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${c}</code>`));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) =>
    safeHref(src) ? keep(`<img src="${esc(src)}" alt="${alt}" loading="lazy">`) : `![${alt}](${src})`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) =>
    safeHref(href)
      ? keep(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`)
      : `${text}(${href})`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // 徽章是「图片套链接」：链接文字本身是个占位符，只还原一层会漏出半截 \0N\0，
  // 于是页面上出现孤零零的「0」「1」。反复还原到没有占位符为止。
  for (let n = 0; n < 5 && s.includes('\u0000'); n++) {
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  }
  return s;
};

export function mdLite(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let list: 'ul' | 'ol' | null = null;
  const closeList = (): void => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const lv = Math.min(h[1].length + 1, 5);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${buf.map(l => inline(l)).join('<br>')}</blockquote>`);
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want: 'ul' | 'ol' = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline(ul ? ul[1] : ol![2])}</li>`);
      i++;
      continue;
    }

    if (!line.trim()) { closeList(); i++; continue; }

    closeList();
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim()
      && !/^\s*(```|#{1,4}\s|>\s?|[-*+]\s|\d+[.)]\s|---+)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  closeList();
  return out.join('');
}

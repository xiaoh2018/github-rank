/* 文章用的小型 Markdown 渲染与导入工具。
   先把所有 HTML 字符转义，再做语法替换，所以输出里不会出现用户写的原始标签。
   链接和图片只允许 http(s):// 或站内以 / 开头的地址。 */
(function (w) {
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(u) {
    var t = String(u).trim();
    if (/^https?:\/\/\S+$/i.test(t)) return t;
    if (/^\/(?!\/)\S*$/.test(t)) return t;
    return null;
  }

  function inline(raw) {
    var keep = [];
    function hold(html) {
      keep.push(html);
      return '\u0001' + (keep.length - 1) + '\u0001';
    }
    var s = esc(raw);
    s = s.replace(/`([^`]+)`/g, function (_, c) { return hold('<code>' + c + '</code>'); });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, url) {
      var u = safeUrl(url);
      if (!u) return hold(alt);
      return hold('<img src="' + u + '" alt="' + alt + '" loading="lazy" decoding="async">');
    });
    s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, function (_, text, url) {
      var u = safeUrl(url);
      if (!u) return text;
      return hold('<a href="' + u + '" target="_blank" rel="nofollow noopener">' + text + '</a>');
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>');
    for (var n = 0; n < 5 && /\u0001\d+\u0001/.test(s); n++) {
      s = s.replace(/\u0001(\d+)\u0001/g, function (_, i) { return keep[Number(i)]; });
    }
    return s;
  }

  function render(md) {
    var lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var para = [];
    var i = 0;
    function flush() {
      if (para.length) {
        out.push('<p>' + para.map(inline).join('<br>') + '</p>');
        para = [];
      }
    }
    while (i < lines.length) {
      var line = lines[i];
      var m;
      if (/^```/.test(line)) {
        flush();
        var code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
        flush();
        var lv = m[1].length + 2;
        out.push('<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>');
        i++;
        continue;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^>\s?/.test(line)) {
        flush();
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push('<blockquote>' + q.map(inline).join('<br>') + '</blockquote>');
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        flush();
        var ordered = /^\s*\d+\.\s+/.test(line);
        var re = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
        var items = [];
        while (i < lines.length && re.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(re, '')) + '</li>');
          i++;
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return out.join('\n');
  }

  // 解析导入的 .md：可选头部 front matter（title / summary / date），
  // 没写标题就取第一个一级标题，并把它从正文里去掉
  function parseMd(text, fileName) {
    var t = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    var meta = {};
    var fm = /^---\n([\s\S]*?)\n---\n?/.exec(t);
    if (fm) {
      fm[1].split('\n').forEach(function (l) {
        var k = /^\s*(title|summary|date)\s*:\s*(.*)$/i.exec(l);
        if (k) meta[k[1].toLowerCase()] = k[2].trim().replace(/^["']|["']$/g, '');
      });
      t = t.slice(fm[0].length);
    }
    if (!meta.title) {
      var h = /^#\s+(.+)$/m.exec(t);
      if (h) {
        meta.title = h[1].trim();
        t = t.replace(/^#\s+.+\n?/m, '');
      }
    }
    if (!meta.title) meta.title = String(fileName || '').replace(/\.(md|markdown|txt)$/i, '');
    var body = t.trim();
    var summary = meta.summary;
    if (!summary) {
      var parts = body.split(/\n\s*\n/);
      for (var p = 0; p < parts.length; p++) {
        var s = parts[p].trim();
        if (!s || /^(#|!\[|```|[-*+>|]\s|\d+\.\s)/.test(s)) continue;
        summary = s.replace(/[*_`>\[\]]/g, '').replace(/\(([^)]*)\)/g, '').replace(/\s+/g, ' ').slice(0, 120);
        break;
      }
    }
    var date = /^\d{4}-\d{2}-\d{2}$/.test(meta.date || '') ? meta.date : '';
    return { title: meta.title || '', summary: summary || '', date: date, body: body };
  }

  w.KeeMd = { render: render, parse: parseMd, esc: esc };
})(window);

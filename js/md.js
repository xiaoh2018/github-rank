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
      return hold('<img src="' + u + '" alt="' + (alt || '配图') + '" loading="lazy" decoding="async">');
    });
    s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, function (_, text, url) {
      var u = safeUrl(url);
      if (!u) return text;
      return hold('<a href="' + u + '" target="_blank" rel="nofollow noopener">' + text + '</a>');
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    for (var n = 0; n < 5 && /\u0001\d+\u0001/.test(s); n++) {
      s = s.replace(/\u0001(\d+)\u0001/g, function (_, i) { return keep[Number(i)]; });
    }
    return s;
  }

  // ---------- 表格（GFM） ----------
  // | 名称 | 地址 |   /  :--- | ---: |  / 单元格里可以有 `code`、**粗体**、链接
  var RE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  function splitRow(line) {
    var t = String(line).trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
    var cells = [];
    var buf = '';
    var inCode = false;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (ch === '`') inCode = !inCode;
      // 代码里的 | 和转义的 \| 都不当分隔符
      if (ch === '|' && !inCode && t.charAt(i - 1) !== '\\') { cells.push(buf); buf = ''; continue; }
      buf += ch;
    }
    cells.push(buf);
    return cells.map(function (c) { return c.trim().replace(/\\\|/g, '|'); });
  }
  function isTableStart(lines, i) {
    if (i + 1 >= lines.length) return false;
    if (String(lines[i]).indexOf('|') < 0) return false;
    if (!RE_SEP.test(lines[i + 1])) return false;
    return splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
  }
  function alignOf(cell) {
    var t = cell.trim();
    var l = t.charAt(0) === ':';
    var r = t.charAt(t.length - 1) === ':';
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return '';
  }
  function renderTable(rows, aligns) {
    function cell(tag, text, idx) {
      var a = aligns[idx] || '';
      var attr = a ? ' style="text-align:' + a + '"' : '';
      return '<' + tag + attr + '>' + inline(text) + '</' + tag + '>';
    }
    var head = rows[0].map(function (c, idx) { return cell('th', c, idx); }).join('');
    var body = rows.slice(1).map(function (r) {
      return '<tr>' + r.map(function (c, idx) { return cell('td', c, idx); }).join('') + '</tr>';
    }).join('');
    return '<div class="md-table"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  // 把常见 HTML 转成 Markdown（GitHub README、富文本文章里经常混着标签）
  function html2md(input) {
    var t = String(input || '');
    if (t.indexOf('<') < 0) return t;
    t = t.replace(/<!--[\s\S]*?-->/g, '');
    t = t.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
    t = t.replace(/<table\b[\s\S]*?<\/table>/gi, function (tb) {
      var rows = [];
      var trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      var m;
      while ((m = trRe.exec(tb))) {
        var cells = [];
        var tdRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
        var c;
        while ((c = tdRe.exec(m[1]))) cells.push(c[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
        if (cells.length) rows.push(cells);
      }
      if (!rows.length) return '';
      var lines = ['| ' + rows[0].join(' | ') + ' |', '|' + rows[0].map(function () { return ' --- '; }).join('|') + '|'];
      for (var r = 1; r < rows.length; r++) lines.push('| ' + rows[r].join(' | ') + ' |');
      return '\n\n' + lines.join('\n') + '\n\n';
    });
    t = t.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, function (_, n, x) {
      var hashes = '';
      for (var k = 0; k < Number(n); k++) hashes += '#';
      return '\n\n' + hashes + ' ' + x.replace(/<[^>]+>/g, '').trim() + '\n\n';
    });
    t = t.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
    t = t.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
    t = t.replace(/<(del|s)\b[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~');
    t = t.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, function (_, x) { return '`' + x.replace(/<[^>]+>/g, '') + '`'; });
    t = t.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, function (_, x) { return '\n\n```\n' + x.replace(/<[^>]+>/g, '') + '\n```\n\n'; });
    t = t.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, function (_, href, text) {
      var label = String(text).replace(/<[^>]+>/g, '').trim();
      return label ? '[' + label + '](' + href + ')' : href;
    });
    t = t.replace(/<img\b[^>]*>/gi, function (tag) {
      var src2 = /src=["']([^"']+)["']/i.exec(tag);
      var alt = /alt=["']([^"']*)["']/i.exec(tag);
      return src2 ? '![' + (alt ? alt[1] : '') + '](' + src2[1] + ')' : '';
    });
    t = t.replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, function (_, x) { return '**' + String(x).replace(/<[^>]+>/g, '').trim() + '**\n\n'; });
    t = t.replace(/<li\b[^>]*>/gi, '\n- ');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');
    t = t.replace(/<\/(p|div|section|article|details|summary|ul|ol|blockquote|figure)>/gi, '\n\n');
    t = t.replace(/<[^>]+>/g, '');
    t = t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t;
  }

  function renderMd(md) {
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
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flush();
        var lv = Math.min(m[1].length + 2, 6);
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
      if (isTableStart(lines, i)) {
        flush();
        var headCells = splitRow(lines[i]);
        var aligns = splitRow(lines[i + 1]).map(alignOf);
        var trows = [headCells];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
          trows.push(splitRow(lines[i]));
          i++;
        }
        out.push(renderTable(trows, aligns));
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        flush();
        var ordered = /^\s*\d+\.\s+/.test(line);
        var re = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
        var items = [];
        while (i < lines.length && re.test(lines[i])) {
          var txt = lines[i].replace(re, '');
          var task = /^\[([ xX])\]\s+/.exec(txt);
          if (task) {
            var on = task[1].toLowerCase() === 'x';
            txt = txt.slice(task[0].length);
            items.push('<li class="md-task"><input type="checkbox" disabled' + (on ? ' checked' : '') + '> ' + inline(txt) + '</li>');
          } else {
            items.push('<li>' + inline(txt) + '</li>');
          }
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

  function render(md) {
    return renderMd(html2md(md));
  }

  w.KeeMd = { render: render, parse: parseMd, esc: esc, html2md: html2md };
})(window);

/**
 * 轻量语法高亮（零依赖）：按语言给关键字/字符串/注释/数字/函数上色。
 * 不追求编译器级准确，只求「读代码更省力」。
 */

const SETS = {
  python: {
    kw: 'def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda yield global nonlocal pass break continue del assert async await match case',
    types: 'int float str list dict set tuple bool bytes object type',
    fn: ['print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sum', 'min', 'max', 'abs', 'round', 'sorted', 'open', 'isinstance', 'append', 'format', 'join', 'items', 'values', 'keys'],
    lineComment: '#',
    triple: true,
  },
  javascript: {
    kw: 'const let var function return if else for while do switch case break continue new class extends super this try catch finally throw typeof instanceof in of delete void yield async await import export from default null undefined true false static get set',
    fn: ['console', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Promise', 'Map', 'Set', 'fetch', 'document', 'window', 'require', 'parseInt', 'parseFloat'],
    lineComment: '//',
    blockComment: true,
  },
  json: { kw: 'true false null', fn: [] },
  yaml: { kw: 'true false null yes no on off', fn: [] },
  bash: {
    kw: 'if then else elif fi for while do done case esac function return export source alias echo cd ls mkdir rm cp mv cat grep sed awk find git npm node python pip curl',
    fn: [],
    lineComment: '#',
  },
  sql: {
    kw: 'select from where group by order having join left right inner outer on as insert into values update set delete create table drop alter index distinct limit offset union all and or not null count sum avg min max case when then else end',
    fn: [],
    lineComment: '--',
  },
  css: { kw: 'important media supports import keyframes', fn: [] },
  latex: { kw: 'documentclass usepackage begin end section subsection subsubsection label ref cite caption includegraphics textbf textit mathbf frac sqrt sum int alpha beta gamma theta lambda sigma omega mu pi det partial nabla times cdot leq geq approx neq infty', fn: [], lineComment: '%' },
  r: {
    kw: 'function if else for while repeat break next TRUE FALSE NULL NA Inf NaN return library require',
    fn: ['print', 'cat', 'mean', 'sd', 'sum', 'lm', 'plot', 'data.frame', 'c', 'matrix', 'length', 'seq', 'rep'],
    lineComment: '#',
  },
  matlab: {
    kw: 'function if else elseif end for while break return switch case otherwise global clear clc close try catch',
    fn: ['disp', 'fprintf', 'sprintf', 'zeros', 'ones', 'eye', 'rand', 'randn', 'linspace', 'size', 'length', 'sum', 'mean', 'plot', 'hold', 'xlabel', 'ylabel', 'title', 'legend', 'fsolve', 'fmincon', 'ode45'],
    lineComment: '%',
  },
};

const ALIAS = {
  js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  node: 'javascript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', powershell: 'bash', ps1: 'bash',
  yml: 'yaml', tex: 'latex', gnuplot: 'bash', text: null, txt: null, plain: null, '': null,
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {string} code 原始代码
 * @param {string} lang 语言标识
 * @returns {string} HTML
 */
export function highlight(code, lang) {
  const key = ALIAS[lang] === undefined ? lang : ALIAS[lang];
  if (!key) return escapeHtml(code);
  const set = SETS[key];
  if (!set) return escapeHtml(code);
  const kw = new Set(set.kw.split(/\s+/).filter(Boolean));
  const fnSet = new Set(set.fn || []);

  let out = '';
  let i = 0;
  const n = code.length;

  const isIdStart = (c) => /[A-Za-z_$\\]/.test(c);
  const isId = (c) => /[A-Za-z0-9_$.\\]/.test(c);
  const isDigit = (c) => /[0-9]/.test(c);

  while (i < n) {
    const c = code[i];
    const rest = code.slice(i);

    // 行注释
    if (set.lineComment && rest.startsWith(set.lineComment) && !rest.startsWith(set.lineComment + set.lineComment)) {
      let j = code.indexOf('\n', i);
      if (j === -1) j = n;
      out += `<span class="tok-com">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // 块注释 /* */
    if (set.blockComment && rest.startsWith('/*')) {
      let j = code.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      out += `<span class="tok-com">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // 字符串
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === c) { j++; break; }
        if (code[j] === '\n' && c !== '`') break;
        j++;
      }
      // python 三引号
      if (set.triple && code.slice(i, i + 3) === c.repeat(3)) {
        const close = code.indexOf(c.repeat(3), i + 3);
        j = close === -1 ? n : close + 3;
      }
      out += `<span class="tok-str">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // 数字
    if (isDigit(c) && !isId(code[i - 1] || '')) {
      let j = i;
      while (j < n && /[0-9._xXa-fA-FeE+-]/.test(code[j])) {
        if (/[+-]/.test(code[j]) && !/[eE]/.test(code[j - 1])) break;
        j++;
      }
      out += `<span class="tok-num">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // 标识符 / 关键字
    if (isIdStart(c)) {
      let j = i;
      while (j < n && isId(code[j])) j++;
      const word = code.slice(i, j);
      const lower = word.toLowerCase();
      const after = !!code.slice(j).match(/^\s*\(/);
      const isKeyword = (key === 'sql' || key === 'latex') ? kw.has(lower) : kw.has(word);
      if (isKeyword) {
        out += `<span class="tok-key">${escapeHtml(word)}</span>`;
      } else if (fnSet.has(word) || (after && !word.includes('.') && key !== 'json' && key !== 'yaml')) {
        out += `<span class="tok-fn">${escapeHtml(word)}</span>`;
      } else {
        out += escapeHtml(word);
      }
      i = j;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

export function highlightAll(root) {
  if (!root) return;
  root.querySelectorAll('code[class*="language-"]').forEach((el) => {
    if (el.dataset.hl === '1') return;
    const langs = [...el.classList].filter((c) => c.startsWith('language-')).map((c) => c.slice(9));
    const lang = langs[0] || 'text';
    if (!lang || lang === 'text' || lang === 'plain') { el.dataset.hl = '1'; return; }
    try {
      el.innerHTML = highlight(el.textContent, lang);
      el.dataset.hl = '1';
    } catch (e) {
      el.dataset.hl = '1';
    }
  });
}

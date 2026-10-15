// Converts the simple inline LaTeX the model sometimes emits ("$\text{CO}_2$")
// into plain Unicode text ("CO₂"). The answer renderer only supports a small
// safe Markdown subset, so unconverted math showed up literally as
// "$\text{CO}_2$". Only `$...$` spans that actually contain LaTeX syntax
// (a backslash, _ or ^) are touched, so currency like "$4 billion ... $5"
// is left alone. Same IIFE-factory pattern as dateFormat.js.
(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.LatexText = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋' };
  const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻' };
  const SYMBOLS = {
    '\\times': '×', '\\cdot': '·', '\\approx': '≈', '\\rightarrow': '→', '\\to': '→',
    '\\leq': '≤', '\\geq': '≥', '\\pm': '±', '\\%': '%', '\\circ': '°',
  };

  function mapChars(str, table) {
    const chars = Array.from(str);
    return chars.every((c) => table[c]) ? chars.map((c) => table[c]).join('') : null;
  }

  function convertMath(inner) {
    let out = inner
      .replace(/\\(?:text|mathrm|mathbf|textbf|mathit)\{([^{}]*)\}/g, '$1')
      .replace(/\\[a-zA-Z%]+/g, (cmd) => SYMBOLS[cmd] ?? '');
    out = out.replace(/_\{([^{}]*)\}|_([0-9+-])/g, (m, braced, single) => {
      const body = braced ?? single;
      return mapChars(body, SUB) ?? `_${body}`;
    });
    out = out.replace(/\^\{([^{}]*)\}|\^([0-9+-])/g, (m, braced, single) => {
      const body = braced ?? single;
      return mapChars(body, SUP) ?? `^${body}`;
    });
    return out.replace(/[{}]/g, '').trim();
  }

  function latexToPlainText(text) {
    return String(text || '').replace(/\$\$?([^$\n]+?)\$\$?/g, (whole, inner) => (
      /[\\_^]/.test(inner) ? convertMath(inner) : whole
    ));
  }

  return { latexToPlainText };
});

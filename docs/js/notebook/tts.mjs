/**
 * GoodNotes 模式 · 页面朗读（浏览器自带 TTS）
 *
 * 用途：把「这一页的文字 + 手写识别结果」读出来，配合逐句高亮，当复读机用。
 * 不依赖外部服务（浏览器自带 speechSynthesis），所以离线也能用；代价是音色由系统决定、中文可读性看系统语音包。
 * 纯逻辑（切句、队列推进、状态）都导出，synth 可注入，便于无浏览器环境测试。
 */

/** 切句：按中英文句末标点与换行切开，去掉空句与过短碎片 */
export function splitSpeakSentences(text, { max = 120, minLen = 1 } = {}) {
  const body = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const parts = body
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？!?；;：:])\s*/))
    .map((s) => s.trim())
    .filter((s) => s.length >= minLen);
  return parts.slice(0, Math.max(1, max));
}

/** 一页要读的内容：文本框 + 手写识别（可选） */
export function pageSpeakText(page, { includeOcr = true, includeText = true } = {}) {
  const bits = [];
  if (includeText) {
    for (const it of ((page && page.items) || [])) {
      if (it && it.kind === 'text' && String(it.text || '').trim()) bits.push(String(it.text).trim());
    }
  }
  if (includeOcr && page && page.ocr && page.ocr.text) bits.push(String(page.ocr.text).trim());
  return bits.join('\n');
}

/**
 * 朗读器：把整段切成句子依次读，并在每句开始时回调（界面据此高亮）
 * @param {object} o { synth, lang, rate, pitch, onSentence, onEnd }
 */
export function makeSpeaker({ synth, lang = 'zh-CN', rate = 1, pitch = 1, onSentence, onEnd } = {}) {
  const S = synth || (typeof speechSynthesis !== 'undefined' ? speechSynthesis : null);
  const supported = !!S && typeof S.speak === 'function';
  let sentences = [];
  let active = -1;
  let stopped = false;

  const Utter = typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null;

  return {
    supported,
    get sentences() { return sentences.slice(); },
    get index() { return active; },
    get speaking() { return active >= 0 && !stopped; },
    /** 开始朗读（会先停掉上一段） */
    speak(text, { from = 0 } = {}) {
      if (!supported) return false;
      this.stop();
      sentences = splitSpeakSentences(text);
      if (!sentences.length) return false;
      stopped = false;
      active = -1;
      sentences.forEach((s, i) => {
        if (i < from) return;
        const u = Utter ? new Utter(s) : { text: s };
        u.lang = lang;
        u.rate = rate;
        u.pitch = pitch;
        u.onstart = () => { active = i; if (onSentence) { try { onSentence(i, s); } catch (e) {} } };
        u.onend = () => {
          if (i === sentences.length - 1 && !stopped) {
            active = -1;
            stopped = true;
            if (onEnd) { try { onEnd(); } catch (e) {} }
          }
        };
        try { S.speak(u); } catch (e) { /* 单个合成失败不影响其它句子 */ }
      });
      return true;
    },
    pause() { if (supported && S.pause) { try { S.pause(); } catch (e) {} } },
    resume() { if (supported && S.resume) { try { S.resume(); } catch (e) {} } },
    stop() {
      stopped = true;
      active = -1;
      if (supported && S.cancel) { try { S.cancel(); } catch (e) {} }
    },
    /** 跳到某一句接着读 */
    jump(i) {
      if (!sentences.length) return false;
      return this.speak(sentences.join('\n'), { from: Math.max(0, Math.min(sentences.length - 1, Number(i) || 0)) });
    },
  };
}

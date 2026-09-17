/**
 * PWA 安装引导
 * 1. 捕获 beforeinstallprompt，在顶栏提供「📲 安装到桌面」按钮（一键安装）
 * 2. iOS Safari 不支持该事件 → 自动弹出图文步骤
 * 3. 已安装状态（standalone）不显示入口
 * 4. 首页在可安装时显示一条可关闭的横幅
 */

const LS_DISMISS = 'note-install-dismissed';
const LS_INSTALLED = 'note-installed';

export const isStandalone = () =>
  (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
  (typeof navigator !== 'undefined' && navigator.standalone === true) ||
  localStorage.getItem(LS_INSTALLED) === '1';

export const isIOS = () =>
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1));

export const isAndroid = () => /Android/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');

export const isDesktop = () => !isIOS() && !isAndroid();

export class InstallGuide {
  /**
   * @param {object} o
   *   o.onStateChange (canInstall:boolean, installed:boolean) => void
   */
  constructor(o = {}) {
    this.o = o;
    this.deferred = null;
    this.host = null;
  }

  /** 开始监听安装事件（尽早调用，事件可能只触发一次） */
  watch() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferred = e;
      this.o.onStateChange && this.o.onStateChange(true, false);
    });
    window.addEventListener('appinstalled', () => {
      this.deferred = null;
      localStorage.setItem(LS_INSTALLED, '1');
      this.o.onStateChange && this.o.onStateChange(false, true);
      this.close();
    });
    setTimeout(() => this.o.onStateChange && this.o.onStateChange(!!this.deferred, isStandalone()), 600);
  }

  canInstall() { return !!this.deferred; }

  /** 点「安装」：能一键装就一键装，否则弹图文说明 */
  async install() {
    if (this.deferred) {
      try {
        this.deferred.prompt();
        const res = await this.deferred.userChoice;
        if (res && res.outcome === 'accepted') {
          localStorage.setItem(LS_INSTALLED, '1');
          this.o.onStateChange && this.o.onStateChange(false, true);
          return { ok: true };
        }
        return { ok: false, reason: 'dismissed' };
      } catch (e) {
        // 落到图文说明
      }
    }
    this.showGuide();
    return { ok: false, reason: 'manual' };
  }

  /** 图文安装步骤（按设备自动选） */
  showGuide() {
    const steps = isIOS() ? this.stepsIOS() : isAndroid() ? this.stepsAndroid() : this.stepsDesktop();
    this.host = document.createElement('div');
    this.host.className = 'inst-guide';
    this.host.innerHTML = `
      <div class="inst-mask" data-inst-close="1"></div>
      <div class="inst-body">
        <div class="inst-head">
          <span class="inst-icon">📲</span>
          <div>
            <h3>把「我的笔记」装成 App</h3>
            <p class="inst-sub">${steps.sub}</p>
          </div>
          <button class="icon-btn round" data-inst-close="1" aria-label="关闭">✕</button>
        </div>
        <ol class="inst-steps">
          ${steps.list.map((s, i) => `<li><span class="inst-num">${i + 1}</span><div><b>${s.t}</b>${s.d ? `<span class="inst-desc">${s.d}</span>` : ''}</div></li>`).join('')}
        </ol>
        ${steps.note ? `<div class="inst-note">${steps.note}</div>` : ''}
        <div class="inst-foot">
          <button class="ql-btn" data-inst-close="1">知道了</button>
          ${this.deferred ? '<button class="ql-btn primary" id="instNow" type="button">现在安装</button>' : ''}
        </div>
      </div>`;
    document.body.appendChild(this.host);
    requestAnimationFrame(() => this.host.classList.add('on'));

    const closeBtn = () => this.close();
    this.host.querySelectorAll('[data-inst-close]').forEach((el) => el.addEventListener('click', closeBtn));
    const now = this.host.querySelector('#instNow');
    if (now) {
      now.addEventListener('click', async () => {
        if (this.deferred) { this.deferred.prompt(); await this.deferred.userChoice; }
        this.close();
      });
    }
    document.addEventListener('keydown', this._esc = (e) => { if (e.key === 'Escape') this.close(); });
  }

  stepsDesktop() {
    return {
      sub: '装完后它会是一个独立窗口的桌面程序，开始菜单和任务栏里都有图标，不联网也能翻已看过的内容。',
      list: [
        { t: '用 Chrome 或 Edge 打开本站', d: '地址栏右边会出现一个「安装」小图标（显示器带下箭头），点它' },
        { t: '或者在浏览器菜单里找', d: 'Chrome：右上角 ⋮ →「投放/保存和分享」→「安装页面为应用」；Edge：⋯ →「应用」→「将此站点作为应用安装」' },
        { t: '确认安装', d: '弹窗点「安装」，桌面和开始菜单就会出现「我的笔记」' },
      ],
      note: '没有安装图标？说明浏览器版本太旧，或当前是无痕窗口——换普通窗口即可。',
    };
  }

  stepsAndroid() {
    return {
      sub: '装到手机主屏后，点图标就像打开 App，全屏无地址栏。',
      list: [
        { t: '用 Chrome 打开本站', d: '' },
        { t: '点右上角 ⋮ 菜单', d: '选择「添加到主屏幕」或「安装应用」' },
        { t: '确认', d: '主屏上会出现「我的笔记」图标' },
      ],
      note: '如果菜单里没有安装项，先下拉刷新一次页面再试。',
    };
  }

  stepsIOS() {
    return {
      sub: 'iPhone / iPad 需要通过 Safari 的「添加到主屏幕」来安装（iOS 不支持一键安装提示）。',
      list: [
        { t: '必须用 Safari 打开本站', d: '微信 / QQ 内置浏览器不支持安装，先点右上角「…」→ 用 Safari 打开' },
        { t: '点底部的「分享」按钮', d: '就是那个方框带向上箭头的图标' },
        { t: '往下滑，选「添加到主屏幕」', d: '再点右上角「添加」' },
        { t: '主屏出现「我的笔记」图标', d: '点开是全屏显示，和 App 一样' },
      ],
      note: 'iOS 的网页 App 有功能限制（后台同步、超大缓存较弱），但看笔记、编辑、标注都正常。',
    };
  }

  close() {
    if (this._esc) document.removeEventListener('keydown', this._esc);
    if (this.host) {
      this.host.classList.remove('on');
      const el = this.host;
      setTimeout(() => el.remove(), 200);
      this.host = null;
    }
  }

  /** 首页横幅（可关闭） */
  banner(container) {
    if (isStandalone() || localStorage.getItem(LS_DISMISS) === '1') return;
    const el = document.createElement('div');
    el.className = 'inst-banner';
    el.innerHTML = `
      <span class="inst-banner-icon">📲</span>
      <div class="inst-banner-text">
        <b>把它装成 App，随时翻开</b>
        <span>桌面 / 主屏图标，全屏无地址栏，断网也能看已缓存的内容</span>
      </div>
      <button class="ql-btn primary" id="instBannerGo" type="button">安装</button>
      <button class="icon-btn round" id="instBannerNo" type="button" aria-label="不再提示">✕</button>`;
    container.prepend(el);
    el.querySelector('#instBannerGo').addEventListener('click', () => this.install());
    el.querySelector('#instBannerNo').addEventListener('click', () => {
      localStorage.setItem(LS_DISMISS, '1');
      el.remove();
    });
  }
}

/*
 * 哔哩哔哩 App 去广告（Loon）
 * ------------------------------------------------------------------
 * 设计取舍：
 *   1. 不内联任何第三方大库，不发起任何额外网络请求，不读写账号数据。
 *   2. grpc-web 响应做 schema-less protobuf 解析：只按字段号定位、只做
 *      字节切片与拼接，不反序列化再序列化，因此不会改动任何业务字段的编码。
 *   3. 所有处理包 try/catch，任何异常一律原样放行，宁可漏广告也不白屏。
 * 适用：iOS 哔哩哔哩 8.x（播放页 viewunite / 动态 DynAll 走 grpc-web）
 * 许可：MIT
 */

const CFG = {
  removeUpList: true,     // 动态页「最常访问的 UP 主」大卡
  removeTabEntry: true,   // 底部「会员购」/ 顶部「游戏中心」
  removeMineBanner: true, // 我的页「热门活动」banner
  removeLiveBanner: true, // 直播间活动 banner
};

// 插件里 argument="debug" 可打开日志（Loon 配置 → 插件 → 参数），留空即关闭
let DEBUG = false;
try { DEBUG = /debug/.test(String($argument || '')); } catch (e) { DEBUG = false; }
const log = (...a) => { if (DEBUG) console.log('[biliad]', ...a); };

// debug 模式下首次成功改写弹一条通知——用来确认脚本到底有没有被调用
// （脚本没跑 = 插件没启用 / MITM 证书没信任，跟规则写得对不对无关）
let NOTIFIED = false;
function notify(msg) {
  if (!DEBUG || NOTIFIED) return;
  NOTIFIED = true;
  try { $notification.post('biliad', '已生效', msg); } catch (e) {}
}

/* ============================ JSON 接口 ============================ */

function handleJson() {
  let raw = $response.body;
  if (typeof raw !== 'string') {
    try { raw = new TextDecoder('utf-8').decode(raw); } catch (e) { return {}; }
  }
  let body;
  try { body = JSON.parse(raw); } catch (e) { log('json parse fail', url); return {}; }
  const data = body && body.data;
  if (!data || typeof data !== 'object') return {};

  try {
    if (/x\/v2\/splash\//.test(url)) stripSplash(data);
    else if (/x\/v2\/feed\/index/.test(url)) stripFeed(data);
    else if (/resource\/show\/tab/.test(url)) stripTab(data);
    else if (/x\/v2\/account\/mine/.test(url)) stripMine(data);
    else if (/xlive\/app-room\/v1\/index\/getInfoByRoom/.test(url)) stripLive(data);
    else if (/dynamic_svr\/v1\/dynamic_svr\/dynamic_(new|history)/.test(url)) stripDynamic(data);
    else { log('no handler', url); return {}; }
  } catch (e) {
    log('handler error', e && e.message);
    return {};
  }
  notify('json ' + String(url).slice(0, 90));
  return { body: JSON.stringify(body) };
}

// 开屏：清空素材列表，客户端走默认占位图
// 开屏素材在响应里必然以数组存在（items / show / event_list 或以后改的新名字），
// 所以直接清掉 data 里的所有数组，标量字段（max_time 等）原样保留。
// 比逐个字段名判断更抗改版，也顺手覆盖摇一摇互动素材。
function stripSplash(d) {
  const cleared = [];
  for (const k of Object.keys(d)) {
    if (Array.isArray(d[k])) { cleared.push(k + '(' + d[k].length + ')'); d[k] = []; }
  }
  // debug 时能看到这次到底清了哪些字段；没有任何数组说明接口结构变了，需要抓包确认
  log('splash cleared:', cleared.join(',') || 'none', '| keys:', Object.keys(d).join(','));
}

// 首页推荐：按 card_type / card_goto 组合剔除推广卡
function stripFeed(d) {
  if (!Array.isArray(d.items)) return;
  d.items = d.items.filter(it => it && !isFeedAd(it));
}

function isFeedAd(item) {
  const ct = String(item.card_type || '');
  const cg = String(item.card_goto || item.goto || '');
  // 任何携带推广元数据的卡片，直接丢弃（新版加了 card_type 但 goto 未变的场景）
  if (item.ad_info) return true;
  if (item.item_args && item.item_args.ad_info) return true;
  if (cg === 'ad' || cg.indexOf('ad_') === 0) return true;
  // 营销位统一前缀：cm_v2 / cm_double_v9 等
  if (ct.indexOf('cm_') === 0) return true;
  // 顶部 banner 位：整版都是 ad 才删，混排正常内容时保留
  if (ct === 'banner_v8' && cg === 'banner') {
    const bs = item.banner_item;
    if (Array.isArray(bs) && bs.length) return bs.every(b => b && b.type === 'ad');
  }
  // 小卡游戏推广
  if (ct === 'small_cover_v10' && cg === 'game') return true;
  return false;
}

// 底部/顶部 tab：去掉会员购、游戏中心入口
function stripTab(d) {
  if (!CFG.removeTabEntry) return;
  const names = { '会员购': 1, '游戏中心': 1 };
  for (const key of ['top', 'bottom']) {
    const arr = d[key];
    if (!Array.isArray(arr)) continue;
    d[key] = arr.filter(it => it && !names[it.name] && it.tab_id !== '会员购Bottom');
    d[key].forEach((it, i) => { if (typeof it.pos === 'number') it.pos = i + 1; });
  }
}

// 我的页：去掉 banner 活动区块
function stripMine(d) {
  if (!CFG.removeMineBanner) return;
  if (!Array.isArray(d.sections_v2)) return;
  d.sections_v2 = d.sections_v2.filter(s => {
    if (!s) return false;
    if (s.id === 'banner') return false;
    return !/热门活动|活动中心/.test(String(s.title || ''));
  });
}

// 直播间：活动 banner 与商品卡
function stripLive(d) {
  if (!CFG.removeLiveBanner) return;
  if (d.activity_banner_info) delete d.activity_banner_info;
  if (Array.isArray(d.shopping_card_list)) d.shopping_card_list = [];
}

// 旧版动态 JSON：card_type 15 = 广告卡
function stripDynamic(d) {
  if (!Array.isArray(d.cards)) return;
  d.cards = d.cards.filter(c => c && c.card_type !== 15);
}

/* ========================= grpc-web 接口 ========================= */

function handleGrpc() {
  let bin = $response.body;
  if (bin instanceof ArrayBuffer) bin = new Uint8Array(bin);
  if (!bin || typeof bin.subarray !== 'function' || bin.length < 5) return {};

  const frame = splitFrame(bin);
  if (!frame) { log('frame parse fail'); return {}; }

  let out;
  try {
    if (/Dynamic\/DynAll/.test(url)) out = stripDynAll(frame.payload);
    else if (/\.View\/View/.test(url)) out = dropField(frame.payload, 7); // ViewReply.cm：UP 主推荐广告
    else { log('no grpc handler', url); return {}; }
  } catch (e) {
    log('proto error', e && e.message);
    return {};
  }
  if (!out || !out.length) return {};

  const headers = Object.assign({}, $response.headers || {});
  for (const k of Object.keys(headers)) {
    if (/^grpc-encoding$/i.test(k)) delete headers[k];
  }
  notify('grpc ' + String(url).slice(0, 90));
  return { body: buildFrame(out, frame.tail), headers };
}

// 拆 grpc-web 数据帧：[flag(1)][len(4, BE)][payload][其余帧原样保留]
function splitFrame(body) {
  const flag = body[0];
  const len = ((body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4]) >>> 0;
  if (5 + len > body.length) return null;
  let payload = body.subarray(5, 5 + len);
  if (flag & 0x80) return null;           // trailer 帧，不参与改写
  if (flag & 0x01) {
    payload = gunzip(payload);
    if (!payload || typeof payload.length !== 'number') return null;
  }
  return { payload, tail: body.subarray(5 + len) };
}

// 重组数据帧：统一以「未压缩」标志输出，故不再需要 grpc-encoding 头
function buildFrame(payload, tail) {
  const n = payload.length;
  const out = new Uint8Array(5 + n + tail.length);
  out[0] = 0;
  out[1] = (n >>> 24) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 8) & 0xff;
  out[4] = n & 0xff;
  out.set(payload, 5);
  out.set(tail, 5 + n);
  return out;
}

// DynAllReply { 1: DynamicList, 2: upList }
function stripDynAll(buf) {
  const parts = [];
  for (const f of readFields(buf)) {
    if (f.no === 2 && CFG.removeUpList) continue;
    if (f.no === 1 && f.wire === 2) {
      parts.push(encodeMessage(1, filterDynItems(payloadOf(buf, f))));
    } else {
      parts.push(buf.subarray(f.start, f.end));
    }
  }
  return concat(parts);
}

// DynamicList { 1: repeated DynamicItem }
function filterDynItems(buf) {
  const parts = [];
  for (const f of readFields(buf)) {
    if (f.no === 1 && f.wire === 2 && isAdCard(payloadOf(buf, f))) continue;
    parts.push(buf.subarray(f.start, f.end));
  }
  return concat(parts);
}

// DynamicItem { 1: card_type }，15 = ad
function isAdCard(buf) {
  for (const f of readFields(buf)) {
    if (f.no === 1 && f.wire === 0) return readVarint(buf, f.valStart)[0] === 15;
  }
  return false;
}

/* ---------------------- 最小 protobuf wire 工具 ---------------------- */

function readVarint(buf, pos) {
  let value = 0;
  let shift = 1;
  for (let i = 0; i < 10; i++) {
    const b = buf[pos++];
    if (b === undefined) throw new Error('varint eof');
    value += (b & 0x7f) * shift;
    if (!(b & 0x80)) return [value, pos];
    shift *= 128;
  }
  throw new Error('varint too long');
}

// 只定位字段边界，不解释值；用于无损切片
function readFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    const [tag, p1] = readVarint(buf, pos);
    pos = p1;
    const no = Math.floor(tag / 8);
    const wire = tag & 7;
    let valStart = pos;
    if (wire === 0) {
      pos = readVarint(buf, pos)[1];
    } else if (wire === 2) {
      const r = readVarint(buf, pos);
      valStart = r[1];
      pos = valStart + r[0];
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      throw new Error('unsupported wire ' + wire);
    }
    if (pos > buf.length) throw new Error('field overflow');
    out.push({ no, wire, start, end: pos, valStart });
  }
  return out;
}

function payloadOf(buf, f) {
  return buf.subarray(f.valStart, f.end);
}

function writeVarint(v) {
  const a = [];
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    a.push(b);
  } while (v);
  return a;
}

function encodeMessage(no, bytes) {
  const head = writeVarint(no * 8 + 2).concat(writeVarint(bytes.length));
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  return out;
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function dropField(buf, no) {
  const parts = [];
  for (const f of readFields(buf)) {
    if (f.no !== no) parts.push(buf.subarray(f.start, f.end));
  }
  return concat(parts);
}

/* ------------------ gzip 解压（宿主 API 优先，纯 JS 兜底） ------------------ */
/*
 * Loon 官方 Script API 文档未列出 $utils，各 build 是否有 $utils.ungzip 不可靠，
 * 因此这里自带一份最小 inflate：先试宿主 API，失败或不存在就走纯 JS。
 */

function gunzip(u8) {
  if (typeof $utils !== 'undefined' && $utils && typeof $utils.ungzip === 'function') {
    try {
      const r = $utils.ungzip(u8);
      if (r && typeof r.length === 'number') return r;
    } catch (e) { /* 落到纯 JS */ }
  }
  return jsGunzip(u8);
}

function jsGunzip(u8) {
  if (!u8 || u8.length < 18 || u8[0] !== 0x1f || u8[1] !== 0x8b) return null;
  const flg = u8[3];
  let p = 10;
  if (flg & 0x04) p += 2 + (u8[p] | (u8[p + 1] << 8));            // FEXTRA
  if (flg & 0x08) { while (p < u8.length && u8[p]) p++; p++; }    // FNAME
  if (flg & 0x10) { while (p < u8.length && u8[p]) p++; p++; }    // FCOMMENT
  if (flg & 0x02) p += 2;                                         // FHCRC
  const n = u8.length;
  const isize = (u8[n - 4] | (u8[n - 3] << 8) | (u8[n - 2] << 16) | (u8[n - 1] << 24)) >>> 0;
  if (p >= n - 8) return null;
  return inflateRaw(u8.subarray(p, n - 8), isize);
}

const IN_LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const IN_LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const IN_DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const IN_DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const IN_CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let IN_FIXED_LIT = null;
let IN_FIXED_DIST = null;

function inflateRaw(src, hint) {
  const br = bitReader(src);
  let out = new Uint8Array(Math.max(hint | 0, 1 << 16));
  let o = 0;
  const need = n => {
    if (o + n <= out.length) return;
    let cap = out.length;
    while (cap < o + n) cap <<= 1;
    const t = new Uint8Array(cap);
    t.set(out.subarray(0, o));
    out = t;
  };

  let last = 0;
  while (!last) {
    last = br.bit();
    const type = br.bits(2);

    if (type === 0) {                                  // 未压缩块
      br.align();
      const p = br.pos();
      const len = src[p] | (src[p + 1] << 8);
      if (p + 4 + len > src.length) throw new Error('stored overflow');
      need(len);
      out.set(src.subarray(p + 4, p + 4 + len), o);
      o += len;
      br.seek(p + 4 + len);
      continue;
    }

    let lit, dist;
    if (type === 1) {
      if (!IN_FIXED_LIT) {
        const l = new Array(288);
        for (let i = 0; i < 144; i++) l[i] = 8;
        for (let i = 144; i < 256; i++) l[i] = 9;
        for (let i = 256; i < 280; i++) l[i] = 7;
        for (let i = 280; i < 288; i++) l[i] = 8;
        IN_FIXED_LIT = buildHuff(l);
        IN_FIXED_DIST = buildHuff(new Array(30).fill(5));
      }
      lit = IN_FIXED_LIT;
      dist = IN_FIXED_DIST;
    } else if (type === 2) {
      const hlit = br.bits(5) + 257;
      const hdist = br.bits(5) + 1;
      const hclen = br.bits(4) + 4;
      const cl = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) cl[IN_CLEN_ORDER[i]] = br.bits(3);
      const clTree = buildHuff(cl);
      const lens = new Array(hlit + hdist).fill(0);
      let i = 0;
      while (i < hlit + hdist) {
        const s = decodeSym(br, clTree);
        if (s < 16) { lens[i++] = s; }
        else if (s === 16) {
          if (i === 0) throw new Error('repeat with no prev');
          const prev = lens[i - 1];
          let n = 3 + br.bits(2);
          while (n--) lens[i++] = prev;
        } else if (s === 17) {
          let n = 3 + br.bits(3);
          while (n--) lens[i++] = 0;
        } else {
          let n = 11 + br.bits(7);
          while (n--) lens[i++] = 0;
        }
      }
      lit = buildHuff(lens.slice(0, hlit));
      dist = buildHuff(lens.slice(hlit));
    } else {
      throw new Error('bad block type');
    }

    for (;;) {                                         // LZ77 主体
      const sym = decodeSym(br, lit);
      if (sym < 256) { need(1); out[o++] = sym; continue; }
      if (sym === 256) break;
      const li = sym - 257;
      if (li >= IN_LEN_BASE.length) throw new Error('bad length sym');
      const len = IN_LEN_BASE[li] + br.bits(IN_LEN_EXTRA[li]);
      const ds = decodeSym(br, dist);
      if (ds >= IN_DIST_BASE.length) throw new Error('bad dist sym');
      const d = IN_DIST_BASE[ds] + br.bits(IN_DIST_EXTRA[ds]);
      const from = o - d;
      if (from < 0) throw new Error('distance overflow');
      need(len);
      for (let i = 0; i < len; i++) out[o++] = out[from + i];
    }
  }
  return out.subarray(0, o);
}

function bitReader(buf) {
  let pos = 0, bitbuf = 0, bitcnt = 0;
  return {
    bit() {
      if (!bitcnt) { bitbuf = buf[pos++]; bitcnt = 8; }
      const v = bitbuf & 1;
      bitbuf >>= 1; bitcnt--;
      return v;
    },
    bits(k) { let v = 0; for (let i = 0; i < k; i++) v |= this.bit() << i; return v; },
    align() { bitbuf = 0; bitcnt = 0; },
    pos() { return pos; },
    seek(p) { pos = p; bitbuf = 0; bitcnt = 0; }
  };
}

// 规范 Huffman 表：counts[len] / syms[按长度排序的符号]
function buildHuff(lens) {
  let max = 0;
  for (let i = 0; i < lens.length; i++) if (lens[i] > max) max = lens[i];
  const counts = new Array(max + 1).fill(0);
  for (let i = 0; i < lens.length; i++) if (lens[i]) counts[lens[i]]++;
  const offs = new Array(max + 2).fill(0);
  for (let i = 1; i <= max; i++) offs[i + 1] = offs[i] + counts[i];
  const syms = new Array(offs[max + 1]);
  for (let s = 0; s < lens.length; s++) if (lens[s]) syms[offs[lens[s]]++] = s;
  return { counts, syms, max };
}

function decodeSym(br, h) {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len <= h.max; len++) {
    code |= br.bit();
    const c = h.counts[len];
    if (code - first < c) return h.syms[index + code - first];
    index += c;
    first = (first + c) << 1;
    code <<= 1;
  }
  throw new Error('huffman overflow');
}

/* ============================== 入口 ============================== */
// 放在文件末尾：所有 const 表已初始化完毕，避免 TDZ
const url = $request.url;
const isGrpc = /\/bilibili\.app\./.test(url) || /grpc\.biliapi\.net/.test(url);

$done(isGrpc ? handleGrpc() : handleJson());

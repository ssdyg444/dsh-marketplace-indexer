#!/usr/bin/env node
// DSH 会话日志修复工具（zstd 多帧格式）
// 用法:
//   node dsh-session-fix.js audit [sessionsRoot]        审计全部会话
//   node dsh-session-fix.js fix <sessionDir>            修复指定会话目录（删除重复 seq 行 + 正确分帧）
const { zstdDecompressSync, zstdCompressSync } = require('node:zlib')
const constants = require('node:zlib').constants
const fs = require('node:fs')
const path = require('node:path')
const ZSTD_MAGIC = 4247762216

function scanZstdFrames(buffer) {
  const frames = []; let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid frame magic @' + offset)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset); offset += 1
    if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6, singleSegment = (descriptor & 32) !== 0, checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3, dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0, blockType = blockHeader >>> 1 & 3, blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('reserved block type')
      offset += (blockType === 1 ? 1 : blockSize)
      if (lastBlock) break
    }
    if (checksum) { if (buffer.length - offset < 4) return { frames, tornStart: start }; offset += 4 }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function decompressAll(raw) {
  const { frames, tornStart } = scanZstdFrames(raw)
  if (tornStart !== undefined) throw new Error('撕裂尾帧 @' + tornStart)
  let text = ''
  for (const f of frames) text += zstdDecompressSync(raw.subarray(f.start, f.end)).toString('utf8')
  return text
}

function compressFramed(headerLine, eventText) {
  const opts = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  // 第一帧必须"恰好一行 header + 末尾换行"（assertZstdHeaderFrame）
  const f1 = zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'), opts)
  // 事件帧：每行记录必须以 \n 结束，否则检查器判定最后一条为"撕裂 JSONL 记录"
  const body = (eventText.endsWith('\n') ? eventText : eventText + '\n')
  const f2 = zstdCompressSync(Buffer.from(body, 'utf8'), opts)
  return Buffer.concat([f1, f2])
}

function auditFile(file) {
  const issues = []
  const raw = Buffer.isBuffer(file) ? file : fs.readFileSync(file)
  const { frames, tornStart } = scanZstdFrames(raw)
  if (tornStart !== undefined) issues.push('撕裂尾帧')
  if (!frames.length) issues.push('无帧')
  const hdr = zstdDecompressSync(raw.subarray(frames[0].start, frames[0].end))
  if (hdr.length === 0 || hdr.indexOf(0x0A) !== hdr.length - 1) issues.push('header 帧非单行')
  try { const h = JSON.parse(hdr.toString('utf8').trim()); if (h.type !== 'session') issues.push('header type=' + h.type) } catch (e) { issues.push('header 非 JSON') }
  const lines = decompressAll(raw).split('\n').filter(l => l.trim())
  let prev = null, dup = 0
  for (const ln of lines) {
    try {
      const o = JSON.parse(ln)
      if (typeof o.seq === 'number') { if (prev !== null && o.seq === prev) dup++; prev = o.seq }
    } catch (e) { issues.push('事件行非 JSON') }
  }
  if (dup) issues.push('重复 seq x' + dup)
  return { frames: frames.length, lines: lines.length, issues }
}

const mode = process.argv[2]
if (mode === 'audit') {
  const root = process.argv[3] || path.join(process.env.USERPROFILE, '.dsh', 'sessions')
  let ok = 0, bad = 0
  for (const proj of fs.readdirSync(root)) {
    const projDir = path.join(root, proj)
    if (!fs.statSync(projDir).isDirectory()) continue
    for (const sess of fs.readdirSync(projDir)) {
      const file = path.join(projDir, sess, 'session.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      try {
        const r = auditFile(file)
        const dupOnly = r.issues.every(i => i.startsWith('重复 seq'))
        const clean = !r.issues.length || (r.issues.length === 1 && dupOnly && r.issues[0] === '重复 seq x1')
        if (r.issues.length && !clean) { bad++; console.log('❌', sess.slice(0, 24), r.issues.join('; ')) }
        else if (r.issues.length) { bad++; console.log('❌', sess.slice(0, 24), r.issues.join('; ')) }
        else { ok++; console.log('✅', sess.slice(0, 24), '(' + r.lines + ' 行)') }
      } catch (e) { bad++; console.log('❌', sess.slice(0, 24), 'FATAL:', e.message) }
    }
  }
  console.log('\n汇总: 正常=' + ok + ' 异常=' + bad)
} else if (mode === 'fix') {
  const sessionDir = process.argv[3]
  const target = path.join(sessionDir, 'session.jsonl.zstd')
  if (!fs.existsSync(target)) { console.log('文件不存在:', target); process.exit(1) }
  fs.copyFileSync(target, target + '.bak-' + Date.now())
  console.log('已备份')
  const text = decompressAll(fs.readFileSync(target))
  const lines = text.split('\n')
  const headerLine = lines[0].trim()
  const rest = lines.slice(1)
  // 删除重复 seq 行（保留第一行）
  const keep = []
  let prev = null, removed = 0
  for (const ln of rest) {
    const t = ln.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (typeof o.seq === 'number') {
        if (prev !== null && o.seq === prev) { removed++; continue }
        prev = o.seq
      }
    } catch (e) {}
    keep.push(t)
  }
  console.log('删除重复行:', removed)
  const out = compressFramed(headerLine, keep.join('\n'))
  fs.writeFileSync(target, out)
  console.log('已重写:', target, out.length, 'bytes')
  // 验证
  const chk = auditFile(fs.readFileSync(target))
  console.log('修复后:', chk.issues.length ? '仍有问题: ' + chk.issues.join('; ') : '✅ 正常 (' + chk.lines + ' 行)')
} else {
  console.log('用法: node dsh-session-fix.js audit [root] | fix <sessionDir>')
}
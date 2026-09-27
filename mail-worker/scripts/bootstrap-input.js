import { emitKeypressEvents } from 'node:readline';

export function parseBootstrapArgs(args) {
  if (!Array.isArray(args) || args[0] !== '--local' || args[1] !== '--email' || !args[2]
    || args[2].startsWith('--') || args.length > 5
    || args.slice(3).some(flag => !['--password-stdin','--login-only'].includes(flag))
    || new Set(args.slice(3)).size !== args.slice(3).length) throw new Error('INVALID_BOOTSTRAP_ARGUMENTS');
  return { email: args[2], passwordStdin: args.includes('--password-stdin'), ...(args.includes('--login-only') ? {loginOnly:true} : {}) };
}

export async function readPasswordFromStream(stream) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 1026) throw new Error('INVALID_PASSWORD_INPUT');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  try {
    const password = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/, '');
    if (/[\r\n]/.test(password) || Buffer.byteLength(password) > 1024) throw new Error('INVALID_PASSWORD_INPUT');
    return password;
  } finally {
    bytes.fill(0);
    chunks.forEach(chunk => chunk.fill(0));
  }
}

export function readHiddenPassword(label) {
  const input = process.stdin;
  if (!input.isTTY) throw new Error('PASSWORD_STDIN_FLAG_REQUIRED');
  emitKeypressEvents(input);
  process.stderr.write(label);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) {
      input.off('keypress', onKey);
      input.off('end', onEnd);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
      value = '';
    }
    function onEnd() { finish(new Error('PASSWORD_INPUT_CANCELLED')); }
    function onKey(text, key = {}) {
      if (key.ctrl && ['c', 'd'].includes(key.name)) return onEnd();
      if (key.name === 'return') return finish();
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) value += text;
      if (Buffer.byteLength(value) > 1024) finish(new Error('INVALID_PASSWORD_INPUT'));
    }
    input.on('keypress', onKey);
    input.once('end', onEnd);
  });
}

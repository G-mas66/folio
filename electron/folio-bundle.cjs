const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const magic = Buffer.from('FOLIO01\n');
const kinds = ['original', 'mono', 'dual'];

async function writeFolioBundle(destination, paper, sources) {
  const handles = [];
  const temporary = path.join(path.dirname(destination), '.folio-' + randomUUID() + '.tmp');
  try {
    for (const kind of kinds) handles.push(await fs.promises.open(sources[kind], 'r'));
    const sizes = await Promise.all(handles.map(async handle => {
      const stat = await handle.stat();
      if (!stat.isFile() || !stat.size) throw Error('PDF 文件不完整，无法导出。');
      return stat.size;
    }));
    const metadata = Buffer.from(JSON.stringify({
      paper: {
        id: paper.id, source_name: paper.source_name, english_title: paper.english_title,
        chinese_title: paper.chinese_title, page_count: paper.page_count,
      },
      sizes,
    }));
    if (metadata.length > 65536) throw Error('文献信息过长，无法导出。');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(metadata.length);
    async function* contents() {
      yield magic;
      yield length;
      yield metadata;
      for (let index = 0; index < handles.length; index += 1) {
        let remaining = sizes[index];
        for await (const chunk of handles[index].createReadStream({ autoClose: false, start: 0, end: remaining - 1 })) {
          remaining -= chunk.length;
          yield chunk;
        }
        if (remaining !== 0) throw Error('导出时 PDF 文件发生变化，请重试。');
      }
    }
    await pipeline(Readable.from(contents()), fs.createWriteStream(temporary, { flags: 'wx' }));
    await fs.promises.rename(temporary, destination);
  } finally {
    await Promise.all(handles.map(handle => handle.close()));
    await fs.promises.rm(temporary, { force: true });
  }
}

module.exports = { writeFolioBundle };

import AdmZip from 'adm-zip';

const MAX_FILE = 2 * 1024 * 1024, MAX_XML = 8 * 1024 * 1024;
const mime = {csv:'text/csv; charset=utf-8',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
const xmlEscape = value => String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const xmlText = value => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all,entity)=>{
  const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
  if(named[entity])return named[entity];
  if(entity.startsWith('#')){const n=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);if(n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff))return String.fromCodePoint(n);}
  return all;
});
function utf8(buffer){try{return new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{throw Error('文件需要 UTF-8 编码；旧版 Office、加密文档和其他二进制格式暂不支持。');}}
function cleanText(text){if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw Error('文件含不支持的二进制或控制字符。');return text;}
function officeParts(buffer){
  if(buffer.length>MAX_FILE)throw Error('单文件不能超过 2 MiB。');
  const zip=new AdmZip(buffer),entries=zip.getEntries();
  if(entries.length>1000)throw Error('Office 文件内部条目过多。');
  let total=0;const names=new Set(),parts=new Map();
  for(const entry of entries){
    const name=entry.entryName;
    if(/(^\/|\\|(^|\/)\.\.(\/|$)|:)/.test(name)||names.has(name.toLowerCase()))throw Error('Office 文件含不安全或重复路径。');
    names.add(name.toLowerCase());
    if(entry.header.encrypted||((entry.attr>>>16)&0xf000)===0xa000)throw Error('不支持加密文件或符号链接。');
    if(/(vbaProject|activeX|embeddings|externalLinks)/i.test(name))throw Error('不支持宏、嵌入对象或外部工作簿。');
    total+=entry.header.size;
    if(!Number.isSafeInteger(total)||entry.header.size>MAX_XML||total>MAX_XML)throw Error('Office 文件展开后不能超过 8 MiB。');
    if(entry.isDirectory||!name.endsWith('.xml'))continue;
    const data=entry.getData();if(data.length!==entry.header.size)throw Error('Office 文件大小校验失败。');
    const xml=utf8(data);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('不支持 XML 文档类型或实体定义。');
    parts.set(name,xml);
  }
  return parts;
}
function texts(xml,tag='t'){return [...xml.matchAll(new RegExp(`<(?:(?:[\\w.-]+):)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${tag}\\s*>`,'g'))].map(m=>xmlText(m[1].replace(/<[^>]*>/g,''))).join('');}
function paragraphs(xml){return [...xml.matchAll(/<(?:\w+:)?p(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?p\s*>/g)].map(m=>texts(m[1].replace(/<(?:\w+:)?tab\b[^>]*\/?\s*>/g,'<t>\t</t>').replace(/<(?:\w+:)?(?:br|cr)\b[^>]*\/?\s*>/g,'<t>\n</t>'))).join('\n');}
function csvCell(value,neutralize=false){let text=String(value??'');if(neutralize&&/^[\s]*[=+@-]/.test(text))text="'"+text;return /[",\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;}
function sheetText(xml,shared){
  const rows=[];let cells=0;
  for(const row of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)){
    const values=[];
    for(const cell of row[1].matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g)){
      if(++cells>20000)throw Error('表格最多支持 20,000 个单元格。');
      const ref=/\br=["']([A-Z]+)\d+["']/.exec(cell[1])?.[1];let col=values.length;
      if(ref){col=0;for(const ch of ref)col=col*26+ch.charCodeAt(0)-64;col--;if(col>511)throw Error('表格最多支持 512 列。');}
      const type=/\bt=["']([^"']+)["']/.exec(cell[1])?.[1];const v=texts(cell[2],'v');
      values[col]=type==='s'?shared[Number(v)]??'':type==='inlineStr'?texts(cell[2]):v;
    }
    rows.push(Array.from({length:values.length},(_,i)=>csvCell(values[i]??'')).join(','));
  }
  return rows.join('\n');
}
/** Content is extracted as untrusted reference text. No links, macros, formulas or code run. */
export function readOfficeFile(path,buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length>MAX_FILE)throw Error('单文件不能超过 2 MiB。');
  const ext=path.split('.').at(-1)?.toLowerCase();
  if(['docx','xlsx','pptx'].includes(ext)){
    let parts;try{parts=officeParts(buffer);}catch(e){throw Error('无法读取 Office 文件：'+e.message);}
    let text='';
    if(ext==='docx'){const doc=parts.get('word/document.xml');if(!doc)throw Error('DOCX 缺少正文。');text=paragraphs(doc);}
    if(ext==='xlsx'){
      const shared=[...(parts.get('xl/sharedStrings.xml')??'').matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(m=>texts(m[1]));
      const sheets=[...parts].filter(([name])=>/^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true}));
      if(!sheets.length)throw Error('XLSX 缺少工作表。');
      text=sheets.map(([name,xml])=>'['+name+']\n'+sheetText(xml,shared)).join('\n\n');
    }
    if(ext==='pptx'){const slides=[...parts].filter(([name])=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true}));if(!slides.length)throw Error('PPTX 缺少幻灯片。');text=slides.map(([name,xml])=>'['+name+']\n'+paragraphs(xml)).join('\n\n');}
    if(text.length>250000)throw Error('提取正文不能超过 250,000 字符，请拆分文件。');
    return {kind:ext,text:cleanText(text),warnings:['仅提取正文/单元格文本；不保留排版、图像、批注或公式计算。XLSX 公式使用文件中保存的缓存值。']};
  }
  if(['pdf','doc','xls','ppt','zip','exe','dll','png','jpg','jpeg','gif','webp','lnk','url'].includes(ext))throw Error('暂不支持此文件格式；请导出 UTF-8 文本、CSV、DOCX、XLSX 或 PPTX。');
  const text=cleanText(utf8(buffer));if(text.length>250000)throw Error('文本不能超过 250,000 字符。');
  return {kind:ext==='csv'?'csv':'text',text,warnings:[]};
}
const declaration='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
function packageOffice(parts){const zip=new AdmZip();for(const [name,text] of Object.entries(parts))zip.addFile(name,Buffer.from(declaration+text));return zip.toBuffer();}
export function createOfficeFile({format,title='工作文档',text='',rows=[]}){
  if(!['csv','docx','xlsx'].includes(format))throw Error('支持 CSV、DOCX 或 XLSX。');
  if(typeof title!=='string'||title.length>200||typeof text!=='string'||text.length>250000)throw Error('文档标题或正文过长。');
  cleanText(title);cleanText(text);
  if(!Array.isArray(rows)||rows.length>2000||rows.some(r=>!Array.isArray(r)||r.length>100)||rows.reduce((n,r)=>n+r.length,0)>20000)throw Error('表格最多 2,000 行、100 列、20,000 个单元格。');
  for(const row of rows)for(const cell of row){if(!['string','number','boolean'].includes(typeof cell)&&cell!==null)throw Error('单元格只能是文本、有限数值、布尔或 null。');if(typeof cell==='number'&&!Number.isFinite(cell))throw Error('单元格数值需要有限。');if(String(cell??'').length>10000)throw Error('单元格内容过长。');cleanText(String(cell??''));}
  let buffer;
  const types='<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>';
  const rels=target=>'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="'+target+'"/></Relationships>';
  if(format==='csv')buffer=Buffer.from('\ufeff'+rows.map(row=>row.map(cell=>csvCell(cell,true)).join(',')).join('\r\n'));
  if(format==='docx')buffer=packageOffice({
    '[Content_Types].xml':types+'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':rels('word/document.xml'),
    'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+[title,...text.split(/\r?\n/)].map(line=>'<w:p><w:r><w:t xml:space="preserve">'+xmlEscape(line)+'</w:t></w:r></w:p>').join('')+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
  });
  if(format==='xlsx')buffer=packageOffice({
    '[Content_Types].xml':types+'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':rels('xl/workbook.xml'),
    'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="工作表" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rows.map((row,i)=>'<row r="'+(i+1)+'">'+row.map(cell=>'<c t="inlineStr"><is><t xml:space="preserve">'+xmlEscape(cell??'')+'</t></is></c>').join('')+'</row>').join('')+'</sheetData></worksheet>'
  });
  if(buffer.length>MAX_FILE)throw Error('生成文件超过 2 MiB，请减少内容。');
  return {buffer,mimeType:mime[format],extension:format};
}

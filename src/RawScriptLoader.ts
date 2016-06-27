import { EOL } from 'os';

const loaderFn: (content: string) => string = (content: string) => {
  content = content.replace(/\\/g, '\\\\');
  content = content.replace(/'/g, '\\\'');
  content = content.replace(/\n/g, '\\n');
  content = content.replace(/\r/g, '\\r');

  const lines: string[] = [
    '(function (global) {',
    `  eval('${content}');`,
    '}.call(exports, (function() { return this; }())))'
  ];

  return lines.join(EOL);
};

/* tslint:disable:export-name */
export = loaderFn;
/* tslint:enable:export-name */

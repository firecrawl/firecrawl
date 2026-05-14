import { useEffect, useRef, useState } from 'react';
import { encryptText } from '@/components/app/(home)/sections/hero/Title/Title';



export default function useSwitchingCode(code: string, ms = 20, progress = 1, fill = true) {
  const [value, setValue] = useState(code);
  const prevCode = useRef(value);

  useEffect(() => {
    if (code === prevCode.current) return;

    let i = 0;

    setValue(prevCode.current);

    let timeout: number;

    const tick = () => {
      i += progress;

      const prevLines = prevCode.current.split('\n');
      const currentLines = code.split('\n');

      const maxLines = fill ? 10 : Math.max(prevLines.length, currentLines.length);
      while (prevLines.length < maxLines) prevLines.push('');
      while (currentLines.length < maxLines) currentLines.push('');

      const remainingLines = prevLines.map((line, index) => {
        if (line === currentLines[index]) return line;

        const charLength = Math.floor(line.length * (i / 30));

        return (currentLines[index]?.slice(0, Math.floor(currentLines[index].length * (i / 30))) ?? '')
         + encryptText(line.slice(charLength), 0, { randomizeChance: 0.5 });
      });

      setValue((fill ? remainingLines : remainingLines.filter((line, index, arr) => {
        if (line === '' && arr[index - 1] === '') return false;

        return true;
      })).join('\n'));

      if (i < 30) {
        timeout = window.setTimeout(tick, ms);
      } else {
        prevCode.current = code;
      }
    };

    tick();

    return () => {
      window.clearTimeout(timeout);
      prevCode.current = code;
    };
  }, [code, ms, progress, fill]);

  return value;
}
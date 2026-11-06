import clsx from 'clsx';
import type { DiffLine } from '../../lib/diff';

/** A line diff as a table: old and new line numbers, a +/- marker, and the text. */
export function LineDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <table className="w-full">
      <tbody>
        {lines.map((line, i) => (
          <tr
            key={i}
            className={clsx(
              line.kind === 'added' && 'bg-[#3f9d5a]/15',
              line.kind === 'removed' && 'bg-danger/15',
            )}
          >
            <td className="w-8 select-none pr-1 text-right text-muted">{line.oldLine ?? ''}</td>
            <td className="w-8 select-none pr-1 text-right text-muted">{line.newLine ?? ''}</td>
            <td className="w-4 select-none text-center">
              {line.kind === 'added' ? (
                <span aria-label="added">+</span>
              ) : line.kind === 'removed' ? (
                <span aria-label="removed">-</span>
              ) : (
                ''
              )}
            </td>
            <td className="whitespace-pre-wrap break-all pr-2">{line.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

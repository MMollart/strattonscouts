import type { ReactNode } from 'react';
import { parseAgreementText, type Inline } from '@shared/agreement-text';

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === 'text') return n.text;
    if (n.type === 'bold') return <strong key={i}>{renderInline(n.children)}</strong>;
    if (n.type === 'italic') return <em key={i}>{renderInline(n.children)}</em>;
    return (
      <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="font-bold text-scout-purple underline">
        {renderInline(n.children)}
      </a>
    );
  });
}

/** Agreement wording, rendered from its safe formatting syntax (never as HTML). */
export function AgreementText({ body }: { body: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {parseAgreementText(body).map((b, i) => {
        if (b.type === 'heading') return b.level === 1 ? <h4 key={i} className="text-lg font-black">{renderInline(b.children)}</h4> : <h5 key={i} className="font-black">{renderInline(b.children)}</h5>;
        if (b.type === 'paragraph') return <p key={i}>{renderInline(b.children)}</p>;
        const List = b.ordered ? 'ol' : 'ul';
        return (
          <List key={i} className={`ml-5 space-y-1 ${b.ordered ? 'list-decimal' : 'list-disc'}`}>
            {b.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
          </List>
        );
      })}
    </div>
  );
}

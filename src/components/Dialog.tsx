import { useEffect, useRef, type ReactNode } from 'react';

/** A native modal dialog: focus moves inside and stays there, Escape closes it. */
export function Dialog({ title, id, onClose, children, wide }: { title: string; id: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      className={`w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} bg-transparent p-0 backdrop:bg-black/40`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="card w-full space-y-4">
        <div className="flex items-start justify-between gap-2">
          <h2 id={id} className="text-2xl">{title}</h2>
          <button type="button" className="text-sm font-bold text-scout-purple" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

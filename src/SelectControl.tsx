import { Component, lazy, Suspense, useRef } from 'react';
import type { ReactNode } from 'react';
import type { SelectControlProps } from './RadixSelectControl';
import { Icon } from './Icons';

export type { SelectOption } from './RadixSelectControl';

// Select controls and their positioning library are fetched on first use.
const RadixSelectControl = lazy(() => import('./RadixSelectControl').then(module => ({ default: module.RadixSelectControl })));

// An already-open page may request an old chunk after a release replaces it.
// Keep a working selector when that fetch fails rather than losing the editor.
class SelectLoadBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function SelectControl(props: SelectControlProps) {
  const { id, value, onChange, options, label, describedBy, disabled } = props;
  const pendingInteraction = useRef({ focused: false, open: false });
  const fallback = <select id={id} className="select-control" value={value} disabled={disabled}
    ref={element => {
      if (element && pendingInteraction.current.focused) { pendingInteraction.current.focused = false; element.focus(); }
    }}
    aria-label={label} aria-describedby={describedBy} onChange={event => onChange(event.target.value)}>
    {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </select>;
  const loading = <button type="button" id={id} className="select-control" role="combobox" disabled={disabled}
    aria-label={label} aria-describedby={describedBy} aria-haspopup="listbox" aria-expanded={false} aria-busy="true"
    onFocus={() => { pendingInteraction.current.focused = true; }}
    onBlur={() => { pendingInteraction.current.focused = false; pendingInteraction.current.open = false; }}
    onPointerDown={event => {
      if (event.button !== 0 || event.ctrlKey) return;
      event.preventDefault(); event.currentTarget.focus(); pendingInteraction.current.open = true;
    }}
    onClick={() => { pendingInteraction.current.focused = true; pendingInteraction.current.open = true; }}
    onKeyDown={event => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); pendingInteraction.current.open = true; }
      else if (event.key === 'Escape' && pendingInteraction.current.open) {
        event.preventDefault(); event.stopPropagation(); pendingInteraction.current.open = false;
      }
    }}>
    <span>{options.find(option => option.value === value)?.label}</span>
    <span className="select-chevron" aria-hidden="true"><Icon name="chevron" size={15} style={{ transform: 'rotate(90deg)' }} /></span>
  </button>;
  return <SelectLoadBoundary fallback={fallback}><Suspense fallback={loading}><RadixSelectControl {...props} pendingInteraction={pendingInteraction} /></Suspense></SelectLoadBoundary>;
}

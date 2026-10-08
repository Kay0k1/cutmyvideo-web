import * as Select from '@radix-ui/react-select';
import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Icon } from './Icons';
import { useLanguage } from './Language';

export interface SelectOption { value: string; label: string; description?: string; disabled?: boolean; }

export interface SelectControlProps {
  id: string;
  value: string;
  onChange(value: string): void;
  options: SelectOption[];
  label?: string;
  describedBy?: string;
  disabled?: boolean;
}

export function RadixSelectControl({ id, value, onChange, options, label, describedBy, disabled, pendingInteraction }: SelectControlProps & {
  pendingInteraction: RefObject<{ focused: boolean; open: boolean }>;
}) {
  const { locale } = useLanguage();
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | undefined>();
  useLayoutEffect(() => {
    const pending = pendingInteraction.current;
    if (!pending.focused || disabled || !trigger.current) return;
    const open = pending.open;
    pending.focused = false; pending.open = false;
    trigger.current.focus();
    if (open) { setContainer(trigger.current.closest('dialog') ?? undefined); trigger.current.click(); }
  }, [pendingInteraction]);
  return <Select.Root key={locale} value={value} onValueChange={onChange} disabled={disabled}
    onOpenChange={open => { if (open) setContainer(trigger.current?.closest('dialog') ?? undefined); }}>
    <Select.Trigger ref={trigger} id={id} className="select-control" aria-label={label} aria-describedby={describedBy}>
      <Select.Value /><Select.Icon className="select-chevron"><Icon name="chevron" size={15} style={{ transform: 'rotate(90deg)' }} /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={container}>
      <Select.Content className="select-popup" position="popper" sideOffset={6} collisionPadding={12}>
        <Select.ScrollUpButton className="select-scroll"><Icon name="chevron" size={15} style={{ transform: 'rotate(-90deg)' }} /></Select.ScrollUpButton>
        <Select.Viewport className="select-options">
          {options.map(option => <Select.Item key={option.value} value={option.value} disabled={option.disabled} textValue={option.label} className="select-option">
            <span className="select-option-text"><Select.ItemText>{option.label}</Select.ItemText>{option.description && <span className="select-description">{option.description}</span>}</span>
            <Select.ItemIndicator className="select-check"><Icon name="check" size={17} /></Select.ItemIndicator>
          </Select.Item>)}
        </Select.Viewport>
        <Select.ScrollDownButton className="select-scroll"><Icon name="chevron" size={15} style={{ transform: 'rotate(90deg)' }} /></Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}

'use client';

import { forwardRef, type ReactNode, type TextareaHTMLAttributes } from 'react';

import Input from '@/components/ui/input';
import { cn } from '@/utils/cn';

const fieldLabelCls =
  'text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56';

interface FieldProps {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Field({ id, label, hint, children, className }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-8', className)}>
      <label htmlFor={id} className={fieldLabelCls}>
        {label}
      </label>
      {children}
      {hint && <p className="text-body-small text-black-alpha-56">{hint}</p>}
    </div>
  );
}

export { Input as FormInput };

type FormTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const FormTextarea = forwardRef<HTMLTextAreaElement, FormTextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        {...props}
        className={cn(
          'block w-full resize-y rounded-8 border border-border-muted bg-accent-white px-12 py-8',
          'font-mono text-mono-small text-accent-black placeholder:text-black-alpha-32',
          'transition-colors duration-150',
          'hover:border-black-alpha-12',
          'focus:border-heat-100 focus:outline-none focus:ring-4 focus:ring-heat-12',
          'disabled:cursor-not-allowed disabled:bg-black-alpha-2 disabled:opacity-70',
          className,
        )}
      />
    );
  },
);
FormTextarea.displayName = 'FormTextarea';

interface FormCheckboxProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: ReactNode;
  hint?: ReactNode;
}

export function FormCheckbox({
  id,
  checked,
  onChange,
  disabled,
  label,
  hint,
}: FormCheckboxProps) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'group flex cursor-pointer items-start gap-12 rounded-8 border border-transparent px-12 py-10',
        'transition-colors duration-150',
        'hover:bg-black-alpha-2',
        disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
      )}
    >
      <span
        className={cn(
          'mt-1 flex h-16 w-16 shrink-0 items-center justify-center rounded-4 border transition-colors',
          checked
            ? 'border-heat-100 bg-heat-100 text-accent-white'
            : 'border-black-alpha-24 bg-accent-white group-hover:border-black-alpha-32',
        )}
        aria-hidden="true"
      >
        {checked && (
          <svg viewBox="0 0 16 16" className="h-12 w-12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3.5 8 7 11.5 12.5 5" />
          </svg>
        )}
      </span>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="sr-only"
      />
      <span className="flex min-w-0 flex-col gap-2">
        <span className="text-body-small text-accent-black">{label}</span>
        {hint && <span className="text-body-small text-black-alpha-56">{hint}</span>}
      </span>
    </label>
  );
}

interface FormToolbarProps {
  status?: ReactNode;
  children: ReactNode;
}

export function FormToolbar({ status, children }: FormToolbarProps) {
  return (
    <div className="flex items-center justify-between gap-12 border-t border-border-faint pt-16">
      <div className="min-w-0 text-body-small text-black-alpha-56">{status}</div>
      <div className="flex items-center gap-8">{children}</div>
    </div>
  );
}

interface AuthStatusProps {
  token: string | null;
}

export function AuthStatus({ token }: AuthStatusProps) {
  if (!token) {
    return <span>No token set.</span>;
  }
  return (
    <>
      Authenticated as{' '}
      <span className="font-mono text-mono-small text-accent-black">
        {token.slice(0, 12)}…
      </span>
    </>
  );
}

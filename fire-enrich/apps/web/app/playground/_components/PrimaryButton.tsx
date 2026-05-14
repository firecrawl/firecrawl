import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from '@/utils/cn';

type PrimaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export const PrimaryButton = forwardRef<HTMLButtonElement, PrimaryButtonProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        {...props}
        className={cn(
          'inline-flex h-36 items-center gap-8 rounded-8 px-14',
          'bg-heat-100 text-accent-white',
          'text-label-medium font-medium',
          'shadow-[inset_0_-1px_0_0_rgba(0,0,0,0.18),0_1px_2px_0_rgba(250,93,25,0.32)]',
          'transition-[transform,background-color,box-shadow] duration-150',
          'hover:bg-heat-90',
          'active:translate-y-[1px] active:shadow-[inset_0_1px_0_0_rgba(0,0,0,0.18)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40 focus-visible:ring-offset-2 focus-visible:ring-offset-background-base',
          'disabled:cursor-not-allowed disabled:bg-black-alpha-16 disabled:text-black-alpha-56 disabled:shadow-none disabled:translate-y-0',
          className,
        )}
      >
        {children}
      </button>
    );
  },
);

PrimaryButton.displayName = 'PrimaryButton';

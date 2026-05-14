import { ButtonHTMLAttributes, forwardRef } from "react";

import { cn } from "@/utils/cn";

import "./button.css";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "tertiary" | "playground" | "destructive";
  size?: "default" | "large";
  disabled?: boolean;
  loadingLabel?: string;
  isLoading?: boolean;
}

const Button = forwardRef<HTMLButtonElement, Props>(
  (
    {
      variant = "primary",
      size = "default",
      disabled,
      isLoading = false,
      loadingLabel = "Loading…",
      ...attrs
    },
    ref,
  ) => {
    const isNonInteractive = Boolean(disabled || isLoading);

    // Focus ring adapts to light/dark variants
    const focusRing =
      variant === "primary" || variant === "destructive"
        ? "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-white"
        : "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-black";

    return (
      <button
        {...attrs}
        ref={ref}
        type={attrs.type ?? "button"}
        aria-disabled={isNonInteractive || undefined}
        aria-busy={isLoading || undefined}
        aria-live={isLoading ? "polite" : undefined}
        data-state={
          isLoading ? "loading" : isNonInteractive ? "disabled" : "idle"
        }
        className={cn(
          attrs.className,
          "flex items-center justify-center button relative [&>*]:relative",
          "text-label-medium lg-max:[&_svg]:size-24",
          `button-${variant} group/button`,
          focusRing,

          // Shared non-interactive styles
          "disabled:cursor-not-allowed",
          isNonInteractive && "cursor-not-allowed",

          // Size
          size === "default" && "rounded-8 px-10 py-6 gap-4",
          size === "large" && "rounded-10 px-12 py-8 gap-6",

          // Variant + interactive nuances
          variant === "primary" && [
            "text-accent-white",
            // Hover/active only when interactive
            !isNonInteractive &&
              "hover:bg-[color:var(--heat-90)] active:[scale:0.995]",
            // Disabled: dim a bit, no hover, dim overlay bg layer if present
            "disabled:opacity-80",
            "disabled:[&_.button-background]:opacity-70",
          ],

          ["secondary", "tertiary", "playground"].includes(variant) && [
            "text-accent-black",
            !isNonInteractive && "active:[scale:0.99] active:bg-black-alpha-7",
          ],

          variant === "secondary" && [
            "bg-black-alpha-4",
            !isNonInteractive && "hover:bg-black-alpha-6",
            // Disabled: lighter fill + muted text, no hover
            "disabled:bg-black-alpha-3",
            "disabled:text-black-alpha-48",
            "disabled:hover:bg-black-alpha-3",
          ],

          variant === "tertiary" && [
            !isNonInteractive && "hover:bg-black-alpha-4",
            // Disabled: no hover background, text muted
            "disabled:text-black-alpha-48",
            "disabled:hover:bg-transparent",
          ],

          variant === "destructive" && [
            "bg-red-600 text-accent-white",
            !isNonInteractive && "hover:bg-red-700 active:scale-[0.98]",
            // Disabled: keep red but softer; soften text slightly
            "disabled:bg-red-600/70",
            "disabled:text-white-alpha-72",
            "disabled:hover:bg-red-600/70",
          ],

          variant === "playground" && [
            "before:inside-border before:border-black-alpha-4",
            isNonInteractive
              ? "before:opacity-0 bg-black-alpha-4 text-black-alpha-24"
              : "hover:bg-black-alpha-4 hover:before:opacity-0 active:before:opacity-0",
          ],
        )}
        disabled={isNonInteractive}
      >
        {variant === "primary" && (
          <div className="overlay button-background !absolute" />
        )}

        {/* loading state (spinner) */}
        {isLoading && (
          <div
            className={cn(
              "w-16 h-16 border-2 rounded-full animate-spin",
              variant === "primary" || variant === "destructive"
                ? "border-white/30 border-t-white"
                : "border-black/30 border-t-black",
            )}
            aria-hidden
          />
        )}

        {/* Screen reader-only loading label */}
        {isLoading && <span className="sr-only">{loadingLabel}</span>}

        {attrs.children}
      </button>
    );
  },
);

Button.displayName = "Button";

export default Button;

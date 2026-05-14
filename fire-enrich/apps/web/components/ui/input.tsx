import { forwardRef } from "react";
import { cn } from "@/utils/cn";

const Input = forwardRef<
  HTMLInputElement,
  React.ComponentPropsWithoutRef<"input">
>(({ className, ...props }, ref) => {
  return (
    <label
      className={cn(
        "py-8 px-12 rounded-8 transition-all w-full block gap-4 cursor-text",
        "relative bg-accent-white",
        "before:inside-border before:border-black-alpha-8 hover:before:border-black-alpha-12 hover:bg-black-alpha-2 focus-within:!bg-accent-white focus-within:before:!border-heat-100 focus-within:before:!border-[1.25px]",
        "text-body-medium",
        className,
      )}
    >
      <input
        ref={ref}
        className="outline-none w-full resize-none bg-transparent"
        {...props}
      />
    </label>
  );
});

Input.displayName = "Input";

export default Input;

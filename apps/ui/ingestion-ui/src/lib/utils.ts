import { type ClassValue, clsx } from "clsx"
import type { KeyboardEvent } from "react"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function handleNumberInputPageKey(
  event: KeyboardEvent<HTMLInputElement>,
  onValueChange: (name: string, value: string) => void,
) {
  if (event.key !== "PageUp" && event.key !== "PageDown") return

  event.preventDefault()
  const currentValue = Number(event.currentTarget.value) || 0
  const value =
    event.key === "PageUp" ? currentValue + 1 : Math.max(0, currentValue - 1)

  onValueChange(event.currentTarget.name, value.toString())
}

import colors from "@/styles/colors.json";

const TYPED_COLORS = colors as unknown as Record<
  string,
  Record<"hex" | "p3", string>
>;

const hslValues = Object.entries(TYPED_COLORS).map(([key, value]) => {
  // Fix hex values - they need # prefix
  const hexValue = value.hex.startsWith("#") ? value.hex : `#${value.hex}`;
  return `--${key}: ${hexValue}`;
});

const p3Values = Object.entries(TYPED_COLORS)
  .filter(([, value]) => value.p3)
  .map(([key, value]) => `--${key}: color(display-p3 ${value.p3})`);

const colorsStyle = `
:root {
  ${hslValues.join(";\n  ")}
}

@supports (color: color(display-p3 1 1 1)) {
  :root {
    ${p3Values.join(";\n    ")}
  }
}`;

export default function ColorStyles() {
  return <style dangerouslySetInnerHTML={{ __html: colorsStyle }} />;
}

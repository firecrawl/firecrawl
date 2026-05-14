import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";

import "@/styles/components/code.css";

export default function Code({
  code,
  language,
  showLineNumbers = true,
}: {
  code: string;
  language: string;
  showLineNumbers?: boolean;
}) {
  return (
    <SyntaxHighlighter
      customStyle={{}}
      language={language}
      showLineNumbers={showLineNumbers}
      useInlineStyles={false}
    >
      {code}
    </SyntaxHighlighter>
  );
}
json.displayName = "json";
json.aliases = ["webmanifest"];

function json(Prism: any) {
  // https://www.json.org/json-en.html
  Prism.languages.json = {
    property: {
      pattern: /(?<=")(?:\\.|[^"\\\r\n])*(?="\s*:)/,
      greedy: true,
    },
    punctuation: {
      pattern: /[{}[\],":]/,
      greedy: true,
    },
    string: {
      pattern: /(?<=")(?:\\.|[^"\\\r\n])*(?=")/,
      greedy: true,
    },
    comment: {
      pattern: /\/\/.*|\/\*[\s\S]*?(?:\*\/|$)/,
      greedy: true,
    },
    number: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i,
    operator: /:/,
    boolean: /\b(?:false|true)\b/,
    null: {
      pattern: /\bnull\b/,
      alias: "keyword",
    },
  };
  Prism.languages.webmanifest = Prism.languages.json;
}

python.displayName = "python";
python.aliases = ["py", "gyp", "ipython"];

function python(Prism: any) {
  Prism.languages.python = {
    comment: {
      pattern: /(^|[^\\])#.*/,
      lookbehind: true,
      greedy: true,
    },
    string: {
      pattern: /("|')(?:\\.|(?!\1)[^\\\r\n])*\1/i,
      greedy: true,
    },
    punctuation: /[{}[\];(),.:"'`]/,
    function: {
      pattern: /((?:^|\s)(?:Firecrawl|scrape_url)\b)/gm,
      greedy: true,
    },
    keyword:
      /\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|exec|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|print|raise|return|try|while|with|yield)\b/,
    boolean: /\b(?:True|False|None)\b/,
    number:
      /\b(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|0b[01]+|0o[0-7]+|0x[a-fA-F0-9]+)\b/i,
    operator:
      /[+%=]=?|!=|<=|>=|<<|>>|\*\*?|\/\/?|\/|&|\||\^|~|\b(?:is|is not|in|not in)\b/,
  };
}

curl.displayName = "curl";
curl.aliases = ["bash", "shell"];

function curl(Prism: any) {
  Prism.languages.curl = {
    comment: {
      pattern: /#.*/,
      greedy: true,
    },
    string: {
      pattern: /(["'])(?:\\.|(?!\1)[^\\\r\n])*\1/,
      greedy: true,
    },
    punctuation: /[{}[\];(),.:"'`$]/,
    function: {
      pattern: /\b(?:curl|POST|GET|PUT|DELETE|PATCH)\b/i,
    },
    keyword: /\b(?:Authorization|Bearer|Content-Type|application\/json)\b/i,
    operator: /[=<>!&|]/,
    number: /\b\d+\b/,
  };
}

SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("curl", curl);

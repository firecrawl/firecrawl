#!/usr/bin/env python3
"""Generate ground truth for the static corpus from each page's SOURCE HTML only.

Python 3.9 stdlib only. No scraper output is ever read here.

    python3 bench/corpus/gen_truth.py            # all pages in manifest.json
    python3 bench/corpus/gen_truth.py 0007 0012  # only these ids (prints debug)

Writes bench/corpus/truth/NNNN.json and, for cross-checking the JS scorer's
normaliser, bench/.work/corpus/text/NNNN.{main,rest}.txt.
"""
import json
import os
import re
import sys
import unicodedata
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, '..', '.work', 'corpus')
PAGES = os.path.join(WORK, 'pages')
TEXT = os.path.join(WORK, 'text')
TRUTH = os.path.join(HERE, 'truth')

BR = '\u2028'       # a <br> outside <pre>; two in a row split a block
POISON = '\ufffc'  # marks a spot no snippet may span (hidden text, sup, img alt, ...)

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
SKIP = {'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'canvas', 'video', 'audio',
        'map', 'datalist', 'select', 'textarea', 'head', 'math', 'dialog'}
HEAD_OK = {'title', 'meta', 'link', 'script', 'style', 'base', 'noscript', 'template'}
BLOCK = {'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset',
         'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main',
         'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td',
         'th', 'ul', 'center', 'html', 'hgroup', 'menu', 'search'}
P_CLOSERS = {'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
             'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav',
             'ol', 'p', 'pre', 'section', 'table', 'ul', 'li', 'dd', 'dt', 'summary', 'center'}
SCOPE = {'table', 'td', 'th', 'caption', 'html', 'template', 'object'}
TABLE_TAGS = {'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption'}
# Inline things whose text converters render in incompatible ways: never inside a snippet.
INLINE_POISON = {'sup', 'sub', 'ruby', 'rt', 'rp', 'button', 'input', 'label', 'wbr', 'img', 'abbr', 'del', 's', 'ins', 'q', 'kbd', 'var', 'time'}

HIDDEN_CLASS = {'sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text', 'screen-reader-only', 'hidden',
                'd-none', 'is-hidden', 'u-hidden', 'hide', 'invisible', 'show-on-focus', 'skip-link', 'skip-to-content',
                'skiplink', 'skip-links', 'mw-jump-link', 'noscript', 'offscreen', 'a11y-hidden', 'assistive-text', 'print-only',
                'visually-hidden-focusable', 'sr-only-focusable', 'collapse', 'tooltip', 'tooltiptext'}
HIDDEN_RE = re.compile(r'visually-?hidden|sr-only|screen-?reader|tooltip|popover', re.I)
POISON_CLASS_RE = re.compile(r'(?:^|[\s_-])(editsection|headerlink|header-anchor|heading-anchor|hash-link|anchor-link|permalink|katex|mathjax|math|lineno|linenos|line-numbers?|copy-button|copybutton|badge|tooltip|footnote-ref|reference|noprint|icon)(?:$|[\s_-])')
HARD_NAV = {'nav', 'navbar', 'navigation', 'topbar', 'top-nav', 'topnav', 'main-nav', 'mainnav', 'global-nav', 'site-nav',
            'main-menu', 'mainmenu', 'primary-nav', 'primary-menu', 'navbar-nav', 'site-navigation', 'main-navigation',
            'globalnav', 'sitenav', 'pagetop'}
HARD_FOOT = {'footer', 'site-footer', 'page-footer', 'global-footer', 'main-footer', 'footer-wrapper', 'colophon', 'contentinfo', 'pagefooter', 'sitefooter', 'yclinks'}
HARD_HEAD = {'site-header', 'masthead', 'page-header-bar', 'global-header', 'main-header', 'siteheader', 'pagehead'}
COOKIE_RE = re.compile(r'cookie|consent|gdpr|onetrust|cc-window|cc-banner', re.I)
SOFT_RE = re.compile(r'(?:^|[\s_-])(sidebar|side-bar|toc|table-of-contents|tableofcontents|breadcrumbs?|navbox|infobox|catlinks|printfooter|hatnote|'
                     r'reflist|references|footnotes|related|share|sharing|social|newsletter|subscribe|pagination|pager|advert|ads|promo|noprint|'
                     r'metadata|feedback|edit-page|edit-this-page|prev-next|prevnext|page-nav|on-this-page|onthispage|sidenav|side-nav|'
                     r'author-bio|byline|tags|taglist|comment-form|reply-form|signup|sign-up|cta|ambox|thumbcaption|authors?|meta|post-meta|'
                     r'vector-toc|mw-indicators|siteSub|contentSub|sistersitebox|side-box|navigation-not-searchable|rellink|dablink|stub|mbox|'
                     r'docs-nav|doc-nav|menu|dropdown|popover|modal|overlay|banner|announcement|alert-banner|versionadded|versionchanged|'
                     r'footer|last-modified|last-mod|lastmod|disclaimer|carousel|slider|swiper|testimonials?|copiable-link)(?:$|[\s_-])', re.I)


class Node(object):
    __slots__ = ('tag', 'attrs', 'children', 'parent', 'tlen', 'rlen', 'flag', 'sub', 'in_article', 'in_main')

    def __init__(self, tag, attrs, parent):
        self.tag = tag
        self.attrs = attrs
        self.children = []
        self.parent = parent
        self.tlen = 0
        self.rlen = 0
        self.flag = ''   # '', 'skip', 'hidden', 'hard', 'soft', 'poison'
        self.sub = ''    # for hard: nav | footer | header | cookie
        self.in_article = False
        self.in_main = False

    def idc(self):
        return ((self.attrs.get('id') or '') + ' ' + (self.attrs.get('class') or '')).strip()

    def classes(self):
        return set((self.attrs.get('class') or '').lower().split())

    def label(self):
        s = self.tag
        if self.attrs.get('id'):
            s += '#' + self.attrs['id'][:30]
        c = (self.attrs.get('class') or '').split()
        if c:
            s += '.' + '.'.join(x[:24] for x in c[:2])
        return s

    def path(self, depth=5):
        out = []
        n = self
        while n is not None and len(out) < depth:
            out.append(n.label())
            n = n.parent
        return ' < '.join(out)


class Builder(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.root = Node('html', {}, None)
        self.stack = [self.root]
        self.body = None
        self.title = None
        self._in_title = False
        self._foreign = 0

    def _find(self, tags, bounds):
        for i in range(len(self.stack) - 1, 0, -1):
            t = self.stack[i].tag
            if t in tags:
                return i
            if t in bounds:
                return -1
        return -1

    def _pop_to(self, i):
        del self.stack[i:]

    def handle_starttag(self, tag, attrs, selfclose=False):
        tag = tag.lower()
        if tag == 'html':
            for k, v in attrs:
                self.root.attrs.setdefault(k, v or '')
            return
        names = [n.tag for n in self.stack]
        if 'head' in names and tag not in HEAD_OK:
            self._pop_to(names.index('head'))
        if tag == 'body':
            if self.body is not None:
                return
            self._pop_to(1)
        if tag == 'title' and self.title is None and 'head' in names:
            self._in_title = True
            self.title = ''
        in_foreign = self._foreign > 0
        if not in_foreign:
            if tag in P_CLOSERS:
                i = self._find({'p'}, SCOPE | {'button'})
                if i > 0:
                    self._pop_to(i)
            if tag == 'li':
                i = self._find({'li'}, {'ul', 'ol', 'menu'} | SCOPE)
                if i > 0:
                    self._pop_to(i)
            elif tag in ('dd', 'dt'):
                i = self._find({'dd', 'dt'}, {'dl'} | SCOPE)
                if i > 0:
                    self._pop_to(i)
            elif tag == 'tr':
                i = self._find({'tr'}, {'table'})
                if i > 0:
                    self._pop_to(i)
            elif tag in ('td', 'th'):
                i = self._find({'td', 'th'}, {'tr', 'table'})
                if i > 0:
                    self._pop_to(i)
            elif tag in ('thead', 'tbody', 'tfoot'):
                i = self._find({'thead', 'tbody', 'tfoot'}, {'table'})
                if i > 0:
                    self._pop_to(i)
            elif tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
                if self.stack[-1].tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
                    self.stack.pop()
            elif tag == 'a':
                i = self._find({'a'}, SCOPE)
                if i > 0:
                    self._pop_to(i)
            elif tag == 'option':
                if self.stack[-1].tag == 'option':
                    self.stack.pop()
        node = Node(tag, dict((k.lower(), v or '') for k, v in attrs), self.stack[-1])
        self.stack[-1].children.append(node)
        if tag == 'body':
            self.body = node
        if tag in VOID or (selfclose and (in_foreign or tag in ('svg', 'math'))):
            return
        if tag in ('svg', 'math'):
            self._foreign += 1
        self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs, selfclose=True)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag == 'title':
            self._in_title = False
        if tag in VOID:
            return
        bounds = set() if tag == 'table' else ({'table'} if tag in TABLE_TAGS else SCOPE - {tag})
        if self._foreign and tag not in ('svg', 'math'):
            bounds = {'svg', 'math'}
        i = self._find({tag}, bounds)
        if i > 0:
            for n in self.stack[i:]:
                if n.tag in ('svg', 'math'):
                    self._foreign = max(0, self._foreign - 1)
            self._pop_to(i)

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        cur = self.stack[-1]
        if cur.tag in ('script', 'style'):
            return
        cur.children.append(data)


def preorder(root):
    out = []
    stack = [root]
    while stack:
        n = stack.pop()
        out.append(n)
        for c in reversed(n.children):
            if not isinstance(c, str):
                stack.append(c)
    return out


def classify(root):
    """Set flag/sub on every element. Flags are per node; traversals inherit them."""
    nodes = preorder(root)
    for n in reversed(nodes):
        if n.tag in SKIP:
            n.rlen = 0
            continue
        n.rlen = sum(len(c.strip()) if isinstance(c, str) else c.rlen for c in n.children)
    total = max(1, root.rlen)
    has_h1 = set()
    for n in nodes:
        if n.tag == 'h1':
            q = n.parent
            while q is not None and id(q) not in has_h1:
                has_h1.add(id(q))
                q = q.parent
    for n in nodes:
        p = n.parent
        n.in_article = bool(p is not None and (p.in_article or p.tag == 'article'))
        n.in_main = bool(p is not None and (p.in_main or p.tag == 'main' or p.attrs.get('role') == 'main'))
        tag = n.tag
        a = n.attrs
        cls = n.classes()
        role = (a.get('role') or '').lower()
        style = (a.get('style') or '').replace(' ', '').lower()
        if tag in SKIP:
            n.flag = 'skip'
            continue
        if ('hidden' in a or a.get('aria-hidden') == 'true' or 'display:none' in style or 'visibility:hidden' in style
                or cls & HIDDEN_CLASS or (tag == 'input' and a.get('type') == 'hidden')
                or (cls and HIDDEN_RE.search(a.get('class') or ''))):
            n.flag = 'hidden'
            continue
        if p is not None and p.tag == 'details' and tag != 'summary' and 'open' not in p.attrs:
            n.flag = 'hidden'
            continue
        if tag in ('body', 'html', 'main') or role == 'main':
            continue
        idc = n.idc().lower()
        toks = set(re.split(r'\s+', idc)) if idc else set()
        if n.rlen > 0.4 * total:
            # a wrapper holding most of the page is never boilerplate because of its class name
            idc, toks = '', set()
        if tag in ('div', 'section', 'aside', 'form', 'dialog', 'p', 'span') and idc and COOKIE_RE.search(idc):
            n.flag, n.sub = 'hard', 'cookie'
        elif tag == 'nav' or role == 'navigation':
            if n.in_article or re.search(r'toc|table-of-contents|tableofcontents|contents', n.idc(), re.I):
                n.flag = 'soft'  # a table of contents is arguably part of the document: never scored either way
            else:
                n.flag, n.sub = 'hard', 'nav'
        elif tag == 'footer' or role == 'contentinfo':
            if n.in_article:
                n.flag = 'soft'
            else:
                n.flag, n.sub = 'hard', 'footer'
        elif ((tag == 'header' and not n.in_article and not n.in_main) or role == 'banner') and id(n) not in has_h1:
            n.flag, n.sub = 'hard', 'header'
        elif role == 'search':
            n.flag = 'soft'
        elif tag in ('div', 'section', 'ul', 'ol', 'table', 'td', 'tr', 'span', 'p', 'center') and toks & HARD_NAV and not n.in_article:
            n.flag, n.sub = 'hard', 'nav'
        elif tag in ('div', 'section', 'table', 'td', 'tr', 'p', 'center', 'span') and toks & HARD_FOOT and not n.in_article:
            n.flag, n.sub = 'hard', 'footer'
        elif tag in ('div', 'section', 'table', 'td', 'tr') and toks & HARD_HEAD and not n.in_article and not n.in_main:
            n.flag, n.sub = 'hard', 'header'
        elif tag == 'aside' or role in ('complementary', 'dialog', 'alertdialog', 'alert', 'toolbar', 'menu', 'menubar', 'tablist'):
            n.flag = 'soft'
        elif tag in INLINE_POISON or tag == 'figcaption' or tag == 'form' or tag == 'fieldset':
            n.flag = 'poison' if tag in INLINE_POISON else 'soft'
        elif idc and POISON_CLASS_RE.search(idc) and tag in ('span', 'a', 'i', 'b', 'small', 'em', 'cite', 'code'):
            n.flag = 'poison'
        elif idc and SOFT_RE.search(idc) and tag not in ('pre', 'code', 'h1', 'h2', 'h3', 'span', 'td', 'th', 'tr', 'em', 'strong', 'b', 'i'):
            n.flag = 'soft'
    # text length of "content-ish" text
    for n in reversed(nodes):
        if n.flag in ('skip', 'hidden', 'hard', 'soft'):
            n.tlen = 0
            continue
        t = 0
        for c in n.children:
            if isinstance(c, str):
                t += len(c.strip())
            else:
                t += c.tlen
        n.tlen = t
    return nodes


def find_all(nodes, pred):
    return [n for n in nodes if pred(n)]


def has_ancestor(n, anc):
    p = n.parent
    while p is not None:
        if p is anc:
            return True
        p = p.parent
    return False


def blocked(n):
    """True if node or an ancestor is skip/hidden/hard/soft."""
    while n is not None:
        if n.flag in ('skip', 'hidden', 'hard', 'soft'):
            return True
        n = n.parent
    return False


def choose_container(b, nodes, url):
    body = b.body or b.root
    why = ''
    total = max(1, body.tlen)
    host = re.sub(r'^https?://([^/]+).*$', r'\1', url)
    # Two documented site hints, where <main> wraps much more than the document.
    if 'wikipedia.org' in host or 'wikisource.org' in host:
        c = [n for n in nodes if n.attrs.get('id') == 'mw-content-text']
        if c:
            return c[0], 'hint:mediawiki'
    if host == 'github.com':
        c = [n for n in nodes if n.tag == 'article' and 'markdown-body' in n.classes() and not blocked(n)]
        if c:
            return max(c, key=lambda n: n.tlen), 'hint:github-readme'
    mains = [n for n in nodes if (n.tag == 'main' or n.attrs.get('role') == 'main') and not blocked(n.parent)]
    M = max(mains, key=lambda n: n.tlen) if mains else None
    if M is not None and (M.tlen < 200 and total > 5 * max(1, M.tlen)):
        M = None
    scope = M if M is not None else body
    arts = [n for n in nodes if n.tag == 'article' and not n.in_article and not blocked(n) and (n is scope or has_ancestor(n, scope))]
    if arts:
        top = max(arts, key=lambda n: n.tlen)
        share = top.tlen / float(max(1, scope.tlen))
        if (len(arts) == 1 and share >= 0.5) or share >= 0.6:
            return top, ('main>article' if M is not None else 'article') + ' share=%.2f' % share
    if M is not None:
        return M, 'main'
    # density descent
    cur = body
    while True:
        kids = [c for c in cur.children if not isinstance(c, str) and c.flag == '']
        if not kids:
            break
        best = max(kids, key=lambda n: n.tlen)
        if best.tlen < 0.7 * max(1, cur.tlen):
            break
        if best.tag in ('p', 'pre', 'ul', 'ol', 'dl', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'font', 'b', 'i'):
            break
        if best.tag in ('table', 'tbody', 'tr', 'td'):
            # only walk through layout tables (a table that itself holds block content)
            if not any(d.tag in ('table', 'p', 'div', 'pre', 'h1', 'h2', 'h3', 'ul', 'ol') for d in preorder(best)[1:400]):
                break
        cur = best
    return cur, 'density'


def collapse(s):
    return re.sub(r'\s+', ' ', s).strip()


class Extract(object):
    """One DFS producing blocks, tables, pres, counts and the two raw text pools."""

    def __init__(self, root, container):
        self.blocks = []
        self.tables = []
        self.pres = []
        self.main_all = []
        self.rest_all = []
        self.hard_text = {}   # node -> list of text pieces (with POISON) in DOM order
        self.items = {'h1': [], 'h2': [], 'h3': [], 'li': [], 'links': []}
        self.container = container
        self.buf = []
        self.buf_links = 0
        self.run(root)

    def hard_add(self, ctx, piece):
        for h in ctx['hards']:
            self.hard_text.setdefault(h, []).append(piece)

    def flush(self, ctx):
        if not self.buf:
            return
        raw = ''.join(self.buf)
        self.buf = []
        links = self.buf_links
        self.buf_links = 0
        if ctx['pre'] is None and BR in raw:
            parts = re.split(BR + r'(?:\s*' + BR + r')+', raw)
            if len(parts) > 1:
                for part in parts:
                    self.buf = [part]
                    self.buf_links = links // len(parts)
                    self.flush(ctx)
                return
            raw = raw.replace(BR, ' ')
        if ctx['pre'] is not None:
            text = raw
        else:
            text = collapse(raw)
        if not text.strip(POISON + ' \n\t'):
            return
        blk = {'text': text, 'node': ctx['block'], 'main': ctx['main'], 'hard': ctx['hard'], 'soft': ctx['soft'],
               'pre': ctx['pre'], 'table': ctx['table'], 'cell': ctx['cell'], 'heading': ctx['heading'],
               'li': ctx['li'], 'links': links, 'hdr': ctx['hdr']}
        self.blocks.append(blk)
        if ctx['cell'] is not None and ctx['table'] is not None:
            ctx['cell']['parts'].append(text)

    def run(self, root):
        ctx0 = {'block': root, 'main': False, 'hard': None, 'soft': False, 'hid': False, 'poison': False, 'pre': None,
                'table': None, 'cell': None, 'heading': 0, 'li': False, 'a': False, 'trec': None, 'hards': (), 'hdr': False, 'code': False}
        stack = [(root, ctx0, False)]
        while stack:
            n, ctx, leaving = stack.pop()
            if isinstance(n, str):
                if ctx['hard'] is not None:
                    self.rest_all.append(n)
                    self.hard_add(ctx, POISON if (ctx['hid'] or ctx['poison']) else n)
                elif ctx['main']:
                    self.main_all.append(n)
                else:
                    self.rest_all.append(n)
                if ctx['hid'] or ctx['poison']:
                    if not self.buf or self.buf[-1] != POISON:
                        self.buf.append(POISON)
                else:
                    self.buf.append(n)
                    if ctx['a']:
                        self.buf_links += len(n.strip())
                continue
            tag = n.tag
            if leaving:
                if tag in BLOCK:
                    self.flush(ctx)
                    if ctx['pre'] is not None and tag != 'pre':
                        self.buf.append('\n')
                continue
            if n.flag == 'skip':
                if tag in ('svg', 'math', 'select', 'textarea', 'iframe', 'video', 'audio', 'canvas', 'object'):
                    self.buf.append(POISON)
                    self.hard_add(ctx, POISON)
                continue
            parent_ctx = ctx
            is_block = tag in BLOCK
            if is_block:
                self.flush(parent_ctx)
                if parent_ctx['pre'] is not None:
                    self.buf.append('\n')
            ctx = dict(parent_ctx)
            if n is self.container:
                ctx['main'] = True
                ctx['soft'] = False
                ctx['hard'] = None
                ctx['hards'] = ()
            if is_block:
                ctx['block'] = n
            if tag == 'header':
                ctx['hdr'] = True
            if tag == 'code':
                ctx['code'] = True
            if n.flag == 'hidden':
                ctx['hid'] = True
            elif n.flag == 'poison':
                ctx['poison'] = True
            elif n.flag == 'hard' and n is not self.container:
                if ctx['hard'] is None:
                    ctx['hard'] = n
                ctx['hards'] = ctx['hards'] + (n,)
            elif n.flag == 'soft' and n is not self.container:
                ctx['soft'] = True
            visible_main = ctx['main'] and ctx['hard'] is None and not ctx['soft'] and not ctx['hid']
            if tag == 'br':
                self.buf.append('\n' if ctx['pre'] is not None else BR)
            elif tag == 'img':
                if (n.attrs.get('alt') or '').strip():
                    self.buf.append(POISON)
                    self.hard_add(ctx, POISON)
            elif tag == 'a':
                ctx['a'] = True
                if visible_main and n.attrs.get('href') and n.tlen > 0:
                    self.items['links'].append(n)
            elif tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
                ctx['heading'] = int(tag[1])
                if visible_main and tag in self.items and n.tlen > 0:
                    self.items[tag].append(n)
            elif tag == 'li':
                ctx['li'] = True
                if visible_main and ctx['pre'] is None:
                    self.items['li'].append(n)
            elif tag == 'pre':
                ctx['pre'] = n
                self.pres.append({'node': n, 'ok': visible_main})
                if ctx['trec'] is not None:
                    ctx['trec']['has_pre'] = True
            elif tag == 'table':
                if parent_ctx['trec'] is not None:
                    parent_ctx['trec']['nested'] = True
                rec = {'node': n, 'rows': [], 'nested': False, 'has_pre': parent_ctx['pre'] is not None or parent_ctx['code'], 'ok': visible_main, 'inner': parent_ctx['table'] is not None}
                if re.search(r'code|highlight|gutter|lineno|line-numbers', n.idc(), re.I):
                    rec['has_pre'] = True
                self.tables.append(rec)
                ctx['table'] = n
                ctx['trec'] = rec
                ctx['cell'] = None
            elif tag == 'tr' and ctx['trec'] is not None:
                ctx['trec']['rows'].append([])
            elif tag in ('td', 'th') and ctx['trec'] is not None and ctx['trec']['rows']:
                cell = {'parts': [], 'th': tag == 'th'}
                ctx['trec']['rows'][-1].append(cell)
                ctx['cell'] = cell
            if ctx['hards']:
                self.hard_add(ctx, ' ')
            stack.append((n, ctx, True))
            for c in reversed(n.children):
                stack.append((c, ctx, False))
        self.flush(ctx0)


# ---------------------------------------------------------------- normaliser
# Must stay equivalent to bench/lib/normalize.mjs (corpus/check-truth.mjs verifies it).
_KEEP = {}
MD_ESC = re.compile(r'\\([!-/:-@\[-`{-~])')
MD_IMG = re.compile(r'!\[[^\[\]]*\]\((?:<[^>]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"]*"|\'[^\']*\'))?\)')
MD_LINK = re.compile(r'\[([^\[\]]*)\]\((?:<[^>]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"]*"|\'[^\']*\'))?\)')
MD_REFLINK = re.compile(r'\[([^\[\]]+)\]\[[^\[\]]*\]')
MD_REFDEF = re.compile(r'^[ \t]*\[[^\[\]]+\]:[ \t]+\S+.*$', re.M)
HTML_TAG = re.compile(r'</?(?:br|p|div|span|a|b|i|em|strong|u|s|del|ins|mark|small|sup|sub|code|pre|kbd|samp|var|img|table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|ul|ol|li|dl|dt|dd|h[1-6]|hr|blockquote|details|summary|section|article|figure|figcaption|picture|source|abbr|cite|q|time|center|font|wbr|nav|header|footer|main|aside|button|label|input|iframe|video|audio)(?:\s[^<>]*)?/?>', re.I)
ENT = {'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'", 'nbsp': ' '}


def _ent(m):
    s = m.group(1)
    if s[0] == '#':
        try:
            return chr(int(s[2:], 16) if s[1] in 'xX' else int(s[1:]))
        except (ValueError, OverflowError):
            return ' '
    return ENT.get(s, m.group(0))


def squash(s):
    out = []
    for ch in s:
        k = _KEEP.get(ch)
        if k is None:
            k = unicodedata.category(ch)[0] in 'LNM'
            _KEEP[ch] = k
        if k:
            out.append(ch)
    return ''.join(out)


def norm(s):
    s = unicodedata.normalize('NFKC', s)
    s = MD_ESC.sub(r'\1', s)
    s = re.sub(r'&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);', _ent, s)
    s = MD_REFDEF.sub(' ', s)
    s = MD_IMG.sub(' ', s)
    s = MD_LINK.sub(r'\1', s)
    s = MD_LINK.sub(r'\1', s)
    s = MD_REFLINK.sub(r'\1', s)
    s = HTML_TAG.sub(' ', s)
    return squash(s.lower())


# ---------------------------------------------------------------- snippet picking
BAD_CHARS = set('<>[]{}|`*_~^#=\\$@&+%/')
SPACELESS = re.compile(u'[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u0e00-\u0e7f\u0e80-\u0eff\u1780-\u17ff\u1000-\u109f]')
TRIM = ' ,;:.!?()"\u201c\u201d\u2018\u2019\'-\u2013\u2014\u2026\u00ab\u00bb\u3001\u3002\uff0c\uff08\uff09\u300c\u300d\u00b6\u00a7'


def clean_ok(s, min_sq, letters=0.6):
    if not s or POISON in s or BR in s:
        return False
    if s.count('(') != s.count(')') or s.count('"') % 2 or s.count(u'\u201c') != s.count(u'\u201d'):
        return False
    if any(c in BAD_CHARS for c in s):
        return False
    low = s.lower()
    if 'http' in low or 'www.' in low:
        return False
    for ch in s:
        cat = unicodedata.category(ch)
        if cat[0] in 'CS' or (cat[0] == 'Z' and ch != ' '):
            return False
    sq = norm(s)
    if len(sq) < min_sq:
        return False
    nl = sum(1 for ch in sq if unicodedata.category(ch)[0] in 'LM')
    return nl >= letters * len(sq)


def is_spaceless(text):
    letters = [c for c in text if unicodedata.category(c)[0] == 'L']
    if not letters:
        return False
    return len(SPACELESS.findall(text)) > 0.3 * len(letters)


def windows(text, minw=6, maxw=12):
    """Yield candidate snippets (sentence-initial windows) from a block's text, in order."""
    for seg in text.split(POISON):
        seg = seg.strip()
        if not seg:
            continue
        if is_spaceless(seg):
            for sent in re.split(u'[\u3002\uff01\uff1f!?\\n]+|(?<=\\.)\\s', seg):
                sent = sent.strip()
                # take the stretch up to the first punctuation / bracket; 12-28 chars
                m = re.search(u'[^\\s,;:()\\[\\]\u3001\uff0c\uff1b\uff1a\uff08\uff09\u300c\u300d\u300e\u300f\u201c\u201d"\']{12,28}', sent)
                if m and clean_ok(m.group(0), 10):
                    yield m.group(0)
            continue
        for sent in re.split(u'(?<=[.!?\u2026\u0964\u061f])["\u201d\u2019)]?\\s+', seg):
            words = sent.split()
            if len(words) < minw:
                continue
            s = ' '.join(words[:maxw]).strip(TRIM)
            if len(s.split()) >= minw and clean_ok(s, 20):
                yield s


def first_window(text, accept, **kw):
    for w in windows(text, **kw):
        if accept(w):
            return w
    return None


def gen(page_id, url, category, html, debug=False):
    b = Builder()
    try:
        b.feed(html)
        b.close()
    except Exception as e:  # html.parser is tolerant; this is a safety net
        sys.stderr.write('%s parse error %r\n' % (page_id, e))
    nodes = classify(b.root)
    container, why = choose_container(b, nodes, url)
    ex = Extract(b.root, container)
    main_raw = ' '.join(ex.main_all)
    rest_raw = ' '.join(ex.rest_all)
    main_sq = norm(main_raw)
    rest_sq = norm(rest_raw)

    must = []
    used = []

    def add(kind, text, blk=None):
        sq = norm(text)
        if not sq or sq not in main_sq:
            return False
        for u in used:
            if len(u) >= 15 and (sq in u or u in sq):
                return False
        used.append(sq)
        item = {'kind': kind, 'text': text}
        if blk is not None:
            item['where'] = blk['node'].path()
        must.append(item)
        return True

    # ---- main heading
    def heading_text(blks):
        for blk in blks:
            parts = [collapse(p).strip(TRIM) for p in blk['text'].split(POISON)]
            parts = [p for p in parts if p and not any(c in '<>[]`|\\' for c in p) and len(norm(p)) >= (2 if is_spaceless(p) else 4)]
            if parts:
                t = max(parts, key=len)
                return ' '.join(t.split()[:15]), blk
        return None, None

    title_sq = norm(b.title or '')

    def title_score(text):
        sq = norm(text.replace(POISON, ' '))
        if not sq or not title_sq:
            return 0.0
        if title_sq.startswith(sq):
            return 3.0
        if sq in title_sq or title_sq in sq:
            return 2.0
        tw = set(w for w in re.split(r'\W+', (b.title or '').lower()) if len(w) > 3)
        hw = set(w for w in re.split(r'\W+', text.lower()) if len(w) > 3)
        return len(tw & hw) / float(len(hw)) if hw else 0.0

    def title_like(text):
        return title_score(text) > 0.5

    h1_main = [x for x in ex.blocks if x['heading'] == 1 and x['main'] and x['hard'] is None and not x['soft']]
    h1_out = [x for x in ex.blocks if x['heading'] == 1 and not x['main'] and x['hard'] is None]
    # prefer the h1 that matches <title>; an h1 outside the container must match it
    head, hblk = heading_text(sorted([x for x in h1_main if title_like(x['text'])], key=lambda x: -title_score(x['text'])))
    if head is None:
        head, hblk = heading_text([x for x in h1_out if title_like(x['text'])])
    if head is None:
        head, hblk = heading_text(h1_main)
    if head is None and len(h1_out) == 1:
        head, hblk = heading_text(h1_out)  # the page's only h1, just outside the detected container
    if head is None and b.title:
        # the longest <title> segment that also appears in the main text
        segs = [collapse(s) for s in re.split(u'\\s+[|\u2013\u2014\u00b7-]\\s+|:\\s+|\\s+::\\s+', b.title)]
        segs = [s for s in segs if len(norm(s)) >= 8 and norm(s) in main_sq and not any(c in '<>[]`|\\' for c in s)]
        if segs:
            head = ' '.join(max(segs, key=len).split()[:15])
    if head is None:
        head, hblk = heading_text([x for x in ex.blocks if x['heading'] == 2 and x['main'] and x['hard'] is None and not x['soft']][:1])
    if head:
        sq = norm(head)
        if sq in main_sq:
            add('heading', head, hblk)
        elif sq in rest_sq:
            # heading sits just outside the detected container (e.g. MediaWiki #firstHeading)
            used.append(sq)
            item = {'kind': 'heading', 'text': head, 'outside_container': True}
            if hblk is not None:
                item['where'] = hblk['node'].path()
            must.append(item)

    # ---- data tables
    def is_data(t):
        if not t['ok'] or t['nested'] or t['has_pre']:
            return False
        node = t['node']
        a = node.attrs
        rows = [r for r in t['rows'] if r]
        full = [r for r in rows if sum(1 for c in r if ''.join(c['parts']).strip(POISON + ' ')) >= 2]
        if len(full) < 2:
            return False
        ncell = sum(len(r) for r in rows)
        if sum(len(''.join(c['parts'])) for r in rows for c in r) > 200 * ncell:
            return False  # cells full of prose: a layout table
        has_th = any(c['th'] for r in rows for c in r)
        layout = a.get('role') == 'presentation' or a.get('border') == '0' or 'cellspacing' in a or 'cellpadding' in a
        return has_th or not layout

    data_tables = [t for t in ex.tables if is_data(t)]
    table_rows = [len([r for r in t['rows'] if r]) for t in data_tables]

    data_ids = set(id(t['node']) for t in data_tables)

    # ---- prose blocks
    def prose_ok(x):
        if not x['main'] or x['hard'] is not None or x['soft']:
            return False
        if x['pre'] is not None or id(x['table']) in data_ids or x['heading'] or x['hdr']:
            return False
        t = x['text'].replace(POISON, '')
        if is_spaceless(t):
            if len(t) < 30:
                return False
        elif len(t.split()) < 8:
            return False
        return x['links'] < 0.5 * len(t)

    prose_all = [x for x in ex.blocks if prose_ok(x)]
    # prose core: walk down from the container while one child holds >= 80% of the prose text,
    # so trailing promos, author bios and comment policies are not picked as "late" content
    weight = {}
    for x in prose_all:
        q = x['node']
        ln = len(x['text'])
        while q is not None:
            weight[id(q)] = weight.get(id(q), 0) + ln
            if q is container:
                break
            q = q.parent
    core = container
    while True:
        kids = [c for c in core.children if not isinstance(c, str) and weight.get(id(c), 0) >= 0.8 * weight.get(id(core), 1)]
        if not kids or kids[0].tag in ('p', 'ul', 'ol', 'dl', 'blockquote', 'li', 'table'):
            break
        core = kids[0]
    in_core = [x for x in prose_all if x['node'] is core or has_ancestor(x['node'], core)]
    if len(in_core) >= 3:
        prose_all = in_core
    else:
        core = container
    prose_p = [x for x in prose_all if x['node'].tag == 'p']
    prose = prose_p if len(prose_p) >= 4 else prose_all

    def accept(w):
        sq = norm(w)
        return sq in main_sq and sq not in rest_sq and main_sq.count(sq) == 1 and not any(len(u) >= 15 and (sq in u or u in sq) for u in used)

    taken = set()

    def pick(order, kind):
        for i in order:
            if i in taken or i < 0 or i >= len(prose):
                continue
            w = first_window(prose[i]['text'], accept)
            if w and add(kind, w, prose[i]):
                taken.add(i)
                return True
        return False

    n = len(prose)
    if n:
        pick(range(0, n), 'early')
        mid = n // 2
        order = []
        for d in range(0, n):
            order.extend([mid + d, mid - d - 1])
        pick(order, 'mid')
        pick(range(n - 1, -1, -1), 'late')
    def n_prose():
        return sum(1 for m in must if m['kind'] in ('early', 'mid', 'late', 'extra'))

    if n_prose() < 3:
        # short pages: further sentences from any prose block
        for x in prose_all:
            for w in windows(x['text']):
                if n_prose() >= 3:
                    break
                if accept(w):
                    add('extra', w, x)
    pre_first = n_prose() < 3 and sum(len(x['text']) for x in ex.blocks if x['pre'] is not None and x['main']) > 0.5 * len(main_raw)
    if n_prose() < 3 and not pre_first:
        # pages made of short fragments (pricing cards, link lists): relax to 3-word windows
        loose = [x for x in ex.blocks if x['main'] and x['hard'] is None and not x['soft'] and x['pre'] is None
                 and id(x['table']) not in data_ids and x['heading'] != 1]
        step = max(1, len(loose) // 6)
        for x in loose[::step] + loose:
            if n_prose() >= 3:
                break
            for w in windows(x['text'], minw=3, maxw=10):
                if len(norm(w)) >= 14 and accept(w) and add('extra', w, x):
                    break

    # ---- table row fragment
    def row_fragment(row):
        cells = [collapse(' '.join(c['parts'])) for c in row]
        for i in range(len(cells) - 1):
            for j in (i + 3, i + 2):
                frag = cells[i:j]
                if len(frag) < 2 or any(not f for f in frag) or len(set(frag)) < len(frag):
                    continue
                s = ' '.join(frag)
                if 2 <= len(s.split()) <= 12 and len(s) <= 100 and clean_ok(s, 8, letters=0.3) and main_sq.count(norm(s)) == 1:
                    return s
        return None

    done = False
    for t in sorted(data_tables, key=lambda t: -len(t['rows'])):
        rows = [r for r in t['rows'] if r and not all(c['th'] for c in r)]
        mid = len(rows) // 2
        for r in rows[mid:] + rows[:mid]:
            s = row_fragment(r)
            if s and add('table_row', s):
                must[-1]['where'] = t['node'].path()
                done = True
                break
        if done:
            break

    # ---- code line
    pre_blocks = [x for x in ex.blocks if x['pre'] is not None and x['main'] and x['hard'] is None and not x['soft']]
    real_pres = []
    seen_pre = set()
    for x in pre_blocks:
        if id(x['pre']) in seen_pre:
            continue
        seen_pre.add(id(x['pre']))
        if norm(x['text']).isdigit() or not norm(x['text']):
            continue
        real_pres.append(x)
    pre_nodes_ok = set(id(p['node']) for p in ex.pres if p['ok'])
    pre_count = len([x for x in real_pres if id(x['pre']) in pre_nodes_ok])

    def code_line(x, loose=False):
        lines = x['text'].split('\n')
        if loose:
            # long preformatted prose (RFCs, mail archives): start from a spot that depends on what is already used
            off = (len(lines) * (1 + len(must))) // 7
            lines = lines[off:] + lines[:off]
        for line in lines:
            s = collapse(line)
            if loose and len(s) > 90:
                s = first_window(s, lambda w: True) or s
            if not (20 <= len(s) <= 90) or len(s.split()) < 3:
                continue
            if POISON in s or any(c in '<>[]`|\\*_~' for c in s) or s[0] in '#/$>%' or 'http' in s or 'www.' in s:
                continue
            if any(unicodedata.category(ch)[0] == 'C' for ch in s):
                continue
            sq = norm(s)
            if len(sq) >= 14 and main_sq.count(sq) == 1 and sq not in rest_sq:
                return s
        return None

    if real_pres:
        mid = len(real_pres) // 2
        for x in real_pres[mid:] + real_pres[:mid]:
            s = code_line(x)
            if s and add('code_line', s):
                must[-1]['where'] = x['pre'].path()
                break

    # ---- top up to four snippets where a heading, table or code line is missing
    if len(must) < 4 and n:
        for frac in (0.25, 0.75, 0.4, 0.6):
            if len(must) >= 4:
                break
            c = int(n * frac)
            order = []
            for d in range(0, n):
                order.extend([c + d, c - d - 1])
            pick(order, 'extra')
    if len(must) < 4 and real_pres:
        k = len(real_pres)
        for idx in (0, k - 1, k // 3, (2 * k) // 3):
            if len(must) >= 4:
                break
            for x in real_pres[idx:] + real_pres[:idx]:
                s2 = code_line(x, loose=True)
                if s2 and add('pre_line', s2):
                    must[-1]['where'] = x['pre'].path()
                    break

    # ---- boilerplate
    must_not = []
    used_not = []

    def add_not(kind, text, node):
        sq = norm(text)
        if len(sq) < (12 if is_spaceless(text) else 18) or sq in main_sq or sq not in rest_sq:
            return False
        if any(sq in u or u in sq for u in used_not):
            return False
        used_not.append(sq)
        must_not.append({'kind': kind, 'text': text, 'where': node.path()})
        return True

    def hard_window(node, minw=3, maxw=8, prefer=None):
        raw = ''.join(ex.hard_text.get(node, []))
        segs = [collapse(s) for s in raw.split(POISON)]
        segs = [s for s in segs if len(s.split()) >= minw or (is_spaceless(s) and len(s) >= 12)]
        if prefer:
            pref = [s for s in segs if prefer.search(s)]
            segs = pref + [s for s in segs if s not in pref]
        for s in segs:
            if is_spaceless(s):
                acc = []
                for tok in s.split()[:8]:
                    acc.append(tok)
                    if len(norm(' '.join(acc))) >= 12:
                        break
                w = ' '.join(acc).strip(TRIM)
                if 12 <= len(norm(w)) <= 40 and not any(c in '<>[]`\\' for c in w):
                    yield w
                for w in windows(s):
                    yield w
                continue
            words = s.split()
            start = 0
            if prefer:
                m = prefer.search(s)
                if m:
                    start = len(s[:m.start()].split())
                    start = min(start, max(0, len(words) - minw))
            for st in (start, 0):
                w = ' '.join(words[st:st + maxw]).strip(TRIM)
                if len(w.split()) >= minw and not any(c in '<>[]`\\' for c in w) and POISON not in w:
                    yield w

    body_level = container.tag in ('body', 'html')
    hard_nodes = [n for n in nodes if n.flag == 'hard' and n in ex.hard_text and not n.in_main
                  and (body_level or not has_ancestor(n, container))]
    by_sub = {}
    for n in hard_nodes:
        by_sub.setdefault(n.sub, []).append(n)
    for n in by_sub.get('nav', []) + by_sub.get('header', []):
        if any(m['kind'] == 'nav' for m in must_not):
            break
        for w in list(hard_window(n, 3, 6)) + list(hard_window(n, 3, 10)):
            if add_not('nav', w, n):
                break
    for n in by_sub.get('cookie', []):
        if any(m['kind'] == 'cookie' for m in must_not):
            break
        for w in hard_window(n, 6, 12):
            if add_not('cookie', w, n):
                break
    legal = re.compile(u'\u00a9|\\(c\\)|copyright|all rights reserved|licensed under|creative commons|trademark', re.I)
    for n in reversed(by_sub.get('footer', [])):
        if any(m['kind'] == 'footer_legal' for m in must_not):
            break
        if not legal.search(''.join(ex.hard_text.get(n, []))):
            continue
        for w in hard_window(n, 4, 10, prefer=legal):
            if legal.search(w) and add_not('footer_legal', w, n):
                break
    for n in reversed(by_sub.get('footer', [])):
        if len(must_not) >= 3 or any(m['kind'] == 'footer' for m in must_not):
            break
        for w in hard_window(n, 4, 8):
            if add_not('footer', w, n):
                break
    if len(must_not) < 2:
        for n in by_sub.get('nav', [])[1:] + by_sub.get('header', []):
            if len(must_not) >= 2:
                break
            for w in hard_window(n, 3, 6):
                if add_not('nav', w, n):
                    break

    # ---- structure counts, inside the content core: walk down from the container while one child
    # holds >= 80% of all visible main text, so related-post grids and promo cards are not counted
    cw = {}
    for x in ex.blocks:
        if not x['main'] or x['hard'] is not None or x['soft']:
            continue
        q = x['node']
        ln = len(x['text'])
        while q is not None:
            cw[id(q)] = cw.get(id(q), 0) + ln
            if q is container:
                break
            q = q.parent
    ccore = container
    while True:
        kids = [c for c in ccore.children if not isinstance(c, str) and cw.get(id(c), 0) >= 0.8 * cw.get(id(ccore), 1)]
        if not kids or kids[0].tag in ('p', 'ul', 'ol', 'dl', 'blockquote', 'li', 'table', 'tbody', 'pre', 'h1', 'h2', 'h3'):
            break
        ccore = kids[0]

    def in_cc(node):
        return node is ccore or has_ancestor(node, ccore)

    # headings, list items and links are counted in the (narrower) prose core: they are what
    # card grids and menus inflate; tables and code blocks are counted in the content core
    def in_pc(node):
        return node is core or has_ancestor(node, core) or has_ancestor(core, node)

    cnt = dict((k, len([n_ for n_ in v if in_pc(n_)])) for k, v in ex.items.items())
    cc_tables = [t for t in data_tables if in_cc(t['node'])]
    table_rows = [len([r for r in t['rows'] if r]) for t in cc_tables]
    pre_count = len([x for x in real_pres if id(x['pre']) in pre_nodes_ok and in_cc(x['pre'])])

    truth = {
        'id': page_id,
        'url': url,
        'category': category,
        'container': container.path(3),
        'container_rule': why,
        'must_contain': must,
        'must_not_contain': must_not,
        'structure': {
            'scope': core.path(2),
            'scope_tables_code': ccore.path(2),
            'headings': cnt['h1'] + cnt['h2'] + cnt['h3'],
            'h1': cnt['h1'], 'h2': cnt['h2'], 'h3': cnt['h3'],
            'tables': len(cc_tables),
            'table_rows': table_rows,
            'code_blocks': pre_count,
            'list_items': cnt['li'],
            'links': cnt['links'],
        },
        'stats': {'main_text_chars': len(collapse(main_raw)), 'page_text_chars': len(collapse(main_raw)) + len(collapse(rest_raw)),
                  'prose_blocks': len(prose_all)},
    }
    return truth, main_raw, rest_raw


def main():
    os.makedirs(TRUTH, exist_ok=True)
    os.makedirs(TEXT, exist_ok=True)
    manifest = json.load(open(os.path.join(HERE, 'manifest.json')))
    only = set(sys.argv[1:])
    weak = []
    if not only:
        keep = set(m['id'] + '.json' for m in manifest)
        for f in os.listdir(TRUTH):
            if f.endswith('.json') and f not in keep:
                os.remove(os.path.join(TRUTH, f))  # stale truth from an earlier, larger manifest
    for m in manifest:
        if only and m['id'] not in only:
            continue
        html = open(os.path.join(PAGES, m['id'] + '.html'), encoding='utf-8', errors='replace').read()
        truth, main_raw, rest_raw = gen(m['id'], m['url'], m['category'], html)
        with open(os.path.join(TRUTH, m['id'] + '.json'), 'w', encoding='utf-8') as f:
            json.dump(truth, f, ensure_ascii=False, indent=1)
            f.write('\n')
        with open(os.path.join(TEXT, m['id'] + '.main.txt'), 'w', encoding='utf-8') as f:
            f.write(main_raw)
        with open(os.path.join(TEXT, m['id'] + '.rest.txt'), 'w', encoding='utf-8') as f:
            f.write(rest_raw)
        nc, nn = len(truth['must_contain']), len(truth['must_not_contain'])
        if only:
            print(json.dumps(truth, ensure_ascii=False, indent=1))
        if nc < 4:
            weak.append((m['id'], m['category'], nc, nn, truth['stats']['main_text_chars'], m['url']))
    if not only:
        print('generated', len(manifest))
        print('pages with <4 must_contain:', len(weak))
        for w in weak:
            print('  ', w)


if __name__ == '__main__':
    main()

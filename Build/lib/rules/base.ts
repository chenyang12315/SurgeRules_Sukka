import { OUTPUT_CLASH_DIR, OUTPUT_MODULES_DIR, OUTPUT_SINGBOX_DIR, OUTPUT_SURGE_DIR } from '../../constants/dir';
import type { Span } from '../../trace';
import { HostnameSmolTrie } from '../trie';
import stringify from 'json-stringify-pretty-compact';
import path from 'node:path';
import { withBannerArray } from '../misc';
import { invariant } from 'foxts/guard';
import picocolors from 'picocolors';
import fs from 'node:fs';
import { writeFile } from '../misc';
import { fastStringArrayJoin } from 'foxts/fast-string-array-join';
import { readFileByLine } from '../fetch-text-by-line';
import { asyncWriteToStream } from 'foxts/async-write-to-stream';

export abstract class RuleOutput<TPreprocessed = unknown> {
  protected domainTrie = new HostnameSmolTrie(null);
  protected domainKeywords = new Set<string>();
  protected domainWildcard = new Set<string>();
  protected userAgent = new Set<string>();
  protected processName = new Set<string>();
  protected processPath = new Set<string>();
  protected urlRegex = new Set<string>();
  protected ipcidr = new Set<string>();
  protected ipcidrNoResolve = new Set<string>();
  protected ipasn = new Set<string>();
  protected ipasnNoResolve = new Set<string>();
  protected ipcidr6 = new Set<string>();
  protected ipcidr6NoResolve = new Set<string>();
  protected geoip = new Set<string>();
  protected groipNoResolve = new Set<string>();

  protected sourceIpOrCidr = new Set<string>();
  protected sourcePort = new Set<string>();
  protected destPort = new Set<string>();

  protected otherRules: string[] = [];
  protected abstract type: 'domainset' | 'non_ip' | 'ip' | (string & {});

  private pendingPromise: Promise<any> | null = null;

  static readonly jsonToLines = (json: unknown): string[] => stringify(json).split('\n');

  whitelistDomain = (domain: string) => {
    this.domainTrie.whitelist(domain);
    return this;
  };

  static readonly domainWildCardToRegex = (domain: string) => {
    let result = '^';
    for (let i = 0, len = domain.length; i < len; i++) {
      switch (domain[i]) {
        case '.':
          result += String.raw`\.`;
          break;
        case '*':
          result += String.raw`[\w.-]*?`;
          break;
        case '?':
          result += String.raw`[\w.-]`;
          break;
        default:
          result += domain[i];
      }
    }
    result += '$';
    return result;
  };

  protected readonly span: Span;

  constructor($span: Span, protected readonly id: string) {
    this.span = $span.traceChild('RuleOutput#' + id);
  }

  protected title: string | null = null;
  withTitle(title: string) {
    this.title = title;
    return this;
  }

  protected description: string[] | readonly string[] | null = null;
  withDescription(description: string[] | readonly string[]) {
    this.description = description;
    return this;
  }

  protected date = new Date();
  withDate(date: Date) {
    this.date = date;
    return this;
  }

  addDomain(domain: string) {
    this.domainTrie.add(domain);
    return this;
  }

  bulkAddDomain(domains: Array<string | null>) {
    let d: string | null;
    for (let i = 0, len = domains.length; i < len; i++) {
      d = domains[i];
      if (d !== null) {
        this.domainTrie.add(d, false, null, 0);
      }
    }
    return this;
  }

  addDomainSuffix(domain: string, lineFromDot = domain[0] === '.') {
    this.domainTrie.add(domain, true, lineFromDot ? 1 : 0);
    return this;
  }

  bulkAddDomainSuffix(domains: string[]) {
    for (let i = 0, len = domains.length; i < len; i++) {
      this.addDomainSuffix(domains[i]);
    }
    return this;
  }

  addDomainKeyword(keyword: string) {
    this.domainKeywords.add(keyword);
    return this;
  }

  private async addFromDomainsetPromise(source: AsyncIterable<string> | Iterable<string> | string[]) {
    for await (const line of source) {
      if (line[0] === '.') {
        this.addDomainSuffix(line, true);
      } else {
        this.domainTrie.add(line, false, null, 0);
      }
    }
  }

  addFromDomainset(source: AsyncIterable<string> | Iterable<string> | string[]) {
    this.pendingPromise = (this.pendingPromise ||= Promise.resolve()).then(() => this.addFromDomainsetPromise(source));
    return this;
  }

  private async addFromRulesetPromise(source: AsyncIterable<string> | Iterable<string>) {
    for await (const line of source) {
      const splitted = line.split(',');
      const type = splitted[0];
      const value = splitted[1];
      const arg = splitted[2];

      switch (type) {
        case 'DOMAIN':
          this.domainTrie.add(value, false, null, 0);
          break;
        case 'DOMAIN-SUFFIX':
          this.addDomainSuffix(value, false);
          break;
        case 'DOMAIN-KEYWORD':
          this.addDomainKeyword(value);
          break;
        case 'DOMAIN-WILDCARD':
          this.domainWildcard.add(value);
          break;
        case 'USER-AGENT':
          this.userAgent.add(value);
          break;
        case 'PROCESS-NAME':
          if (value.includes('/') || value.includes('\\')) {
            this.processPath.add(value);
          } else {
            this.processName.add(value);
          }
          break;
        case 'URL-REGEX': {
          const [, ...rest] = splitted;
          this.urlRegex.add(rest.join(','));
          break;
        }
        case 'IP-CIDR':
          (arg === 'no-resolve' ? this.ipcidrNoResolve : this.ipcidr).add(value);
          break;
        case 'IP-CIDR6':
          (arg === 'no-resolve' ? this.ipcidr6NoResolve : this.ipcidr6).add(value);
          break;
        case 'IP-ASN':
          (arg === 'no-resolve' ? this.ipasnNoResolve : this.ipasn).add(value);
          break;
        case 'GEOIP':
          (arg === 'no-resolve' ? this.groipNoResolve : this.geoip).add(value);
          break;
        case 'SRC-IP':
          this.sourceIpOrCidr.add(value);
          break;
        case 'SRC-PORT':
          this.sourcePort.add(value);
          break;
        case 'DEST-PORT':
          this.destPort.add(value);
          break;
        default:
          this.otherRules.push(line);
          break;
      }
    }
  }

  addFromRuleset(source: AsyncIterable<string> | Iterable<string> | Promise<Iterable<string>>) {
    if (this.pendingPromise) {
      this.pendingPromise = this.pendingPromise.then(() => source);
    } else {
      this.pendingPromise = Promise.resolve(source);
    }
    this.pendingPromise = this.pendingPromise.then((source) => this.addFromRulesetPromise(source));
    return this;
  }

  static readonly ipToCidr = (ip: string, version: 4 | 6) => {
    if (ip.includes('/')) return ip;
    if (version === 4) {
      return ip + '/32';
    }
    return ip + '/128';
  };

  bulkAddCIDR4(cidrs: string[]) {
    for (let i = 0, len = cidrs.length; i < len; i++) {
      this.ipcidr.add(RuleOutput.ipToCidr(cidrs[i], 4));
    }
    return this;
  }

  bulkAddCIDR4NoResolve(cidrs: string[]) {
    for (let i = 0, len = cidrs.length; i < len; i++) {
      this.ipcidrNoResolve.add(RuleOutput.ipToCidr(cidrs[i], 4));
    }
    return this;
  }

  bulkAddCIDR6(cidrs: string[]) {
    for (let i = 0, len = cidrs.length; i < len; i++) {
      this.ipcidr6.add(RuleOutput.ipToCidr(cidrs[i], 6));
    }
    return this;
  }

  bulkAddCIDR6NoResolve(cidrs: string[]) {
    for (let i = 0, len = cidrs.length; i < len; i++) {
      this.ipcidr6NoResolve.add(RuleOutput.ipToCidr(cidrs[i], 6));
    }
    return this;
  }

  protected abstract preprocess(): TPreprocessed extends null ? null : NonNullable<TPreprocessed>;

  async done() {
    await this.pendingPromise;
    this.pendingPromise = null;
    return this;
  }

  private guardPendingPromise() {
    // reverse invariant
    if (this.pendingPromise !== null) {
      console.trace('Pending promise:', this.pendingPromise);
      throw new Error('You should call done() before calling this method');
    }
  }

  private $$preprocessed: TPreprocessed | null = null;
  protected runPreprocess() {
    if (this.$$preprocessed === null) {
      this.guardPendingPromise();

      this.$$preprocessed = this.span.traceChildSync('preprocess', () => this.preprocess());
    }
  }

  get $preprocessed(): TPreprocessed extends null ? null : NonNullable<TPreprocessed> {
    this.runPreprocess();
    return this.$$preprocessed as any;
  }

  async writeClash(outputDir?: null | string) {
    await this.done();

    invariant(this.title, 'Missing title');
    invariant(this.description, 'Missing description');

    return compareAndWriteFile(
      this.span,
      withBannerArray(
        this.title,
        this.description,
        this.date,
        this.clash()
      ),
      path.join(outputDir ?? OUTPUT_CLASH_DIR, this.type, this.id + '.txt')
    );
  }

  write({
    surge = true,
    clash = true,
    singbox = true,
    surgeDir = OUTPUT_SURGE_DIR,
    clashDir = OUTPUT_CLASH_DIR,
    singboxDir = OUTPUT_SINGBOX_DIR
  }: {
    surge?: boolean,
    clash?: boolean,
    singbox?: boolean,
    surgeDir?: string,
    clashDir?: string,
    singboxDir?: string
  } = {}): Promise<void> {
    return this.done().then(() => this.span.traceChildAsync('write all', async () => {
      invariant(this.title, 'Missing title');
      invariant(this.description, 'Missing description');

      const promises: Array<Promise<void>> = [];

      if (surge) {
        promises.push(compareAndWriteFile(
          this.span,
          withBannerArray(
            this.title,
            this.description,
            this.date,
            this.surge()
          ),
          path.join(surgeDir, this.type, this.id + '.conf')
        ));
      }
      if (clash) {
        promises.push(compareAndWriteFile(
          this.span,
          withBannerArray(
            this.title,
            this.description,
            this.date,
            this.clash()
          ),
          path.join(clashDir, this.type, this.id + '.txt')
        ));
      }
      if (singbox) {
        promises.push(compareAndWriteFile(
          this.span,
          this.singbox(),
          path.join(singboxDir, this.type, this.id + '.json')
        ));
      }

      if (this.mitmSgmodule) {
        const sgmodule = this.mitmSgmodule();
        const sgModulePath = this.mitmSgmodulePath ?? path.join(this.type, this.id + '.sgmodule');

        if (sgmodule) {
          promises.push(
            compareAndWriteFile(
              this.span,
              sgmodule,
              path.join(OUTPUT_MODULES_DIR, sgModulePath)
            )
          );
        }
      }

      await Promise.all(promises);
    }));
  }

  abstract surge(): string[];
  abstract clash(): string[];
  abstract singbox(): string[];

  protected mitmSgmodulePath: string | null = null;
  withMitmSgmodulePath(path: string | null) {
    if (path) {
      this.mitmSgmodulePath = path;
    }
    return this;
  }
  abstract mitmSgmodule?(): string[] | null;
}

export async function fileEqual(linesA: string[], source: AsyncIterable<string> | Iterable<string>): Promise<boolean> {
  if (linesA.length === 0) {
    return false;
  }

  const linesABound = linesA.length - 1;

  let index = -1;
  for await (const lineB of source) {
    index++;

    if (index > linesABound) {
      return (index === linesA.length && lineB.length === 0);
    }

    const lineA = linesA[index];

    if (lineA.length === 0 && lineB.length === 0) {
      continue;
    }

    // not both line are empty
    if (lineA.length === 0 || lineB.length === 0) {
      return false;
    }

    const firstCharA = lineA.charCodeAt(0);
    const firstCharB = lineB.charCodeAt(0);

    if (firstCharA !== firstCharB) {
      return false;
    }

    if (firstCharA === 35 /* # */ && firstCharB === 35 /* # */) {
      continue;
    }
    // adguard conf
    if (firstCharA === 33 /* ! */ && firstCharB === 33 /* ! */) {
      continue;
    }

    if (
      firstCharA === 47 /* / */ && firstCharB === 47 /* / */
      && lineA[1] === '/' && lineB[1] === '/'
      && lineA[3] === '#' && lineB[3] === '#'
    ) {
      continue;
    }

    if (lineA !== lineB) {
      return false;
    }
  }

  // The file becomes larger
  return !(index < linesABound);
}

export async function compareAndWriteFile(span: Span, linesA: string[], filePath: string) {
  const linesALen = linesA.length;

  const isEqual = await span.traceChildAsync(`compare ${filePath}`, async () => {
    if (fs.existsSync(filePath)) {
      return fileEqual(linesA, readFileByLine(filePath));
    }

    console.log(`${filePath} does not exists, writing...`);
    return false;
  });

  if (isEqual) {
    console.log(picocolors.gray(picocolors.dim(`same content, bail out writing: ${filePath}`)));
    return;
  }

  await span.traceChildAsync(`writing ${filePath}`, async () => {
    // The default highwater mark is normally 16384,
    // So we make sure direct write to file if the content is
    // most likely less than 500 lines
    if (linesALen < 500) {
      return writeFile(filePath, fastStringArrayJoin(linesA, '\n') + '\n');
    }

    const writeStream = fs.createWriteStream(filePath);
    for (let i = 0; i < linesALen; i++) {
      const p = asyncWriteToStream(writeStream, linesA[i] + '\n');
      // eslint-disable-next-line no-await-in-loop -- stream high water mark
      if (p) await p;
    }

    writeStream.end();
  });
}

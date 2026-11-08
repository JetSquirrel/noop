// The app's study page: lessons are Markdown files the tutor writes under reports/study/ (see templates/agents/tutor/profile.md).

export const STUDY_PREFIX = "reports/study/";
export const STUDY_DONE_KEY = "hub.study.done";

export type StudyItem = { path: string; id: string; title: string; updated: number };
export type QuizCard = { q: string; a: string };
export type Lesson = { title: string; project: string; mode: string; body: string; quiz: QuizCard[] };

/** Lessons, newest first. The title is in the file name, so the list needs no read per lesson. */
export function studyItems(files: { path: string; updated?: number | string }[]): StudyItem[] {
  return files
    .filter((f) => f.path.startsWith(STUDY_PREFIX) && f.path.endsWith(".md"))
    .map((f) => {
      const name = f.path.slice(STUDY_PREFIX.length, -3);
      const m = /^(T-[\w-]*?\d{4})(?:-(.+))?$/.exec(name);
      return { path: f.path, id: m?.[1] ?? "", title: m?.[2] || name, updated: typeof f.updated === "number" ? f.updated : Date.parse(f.updated ?? "") || 0 };
    })
    .sort((a, b) => b.updated - a.updated);
}

function frontMatter(md: string): { meta: Record<string, string>; rest: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { meta: {}, rest: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, rest: md.slice(m[0].length) };
}

const QUESTION = /^Q[:：]\s*/, ANSWER = /^A[:：]\s*/;

function parseQuiz(text: string): QuizCard[] {
  const cards: QuizCard[] = [];
  let field: "q" | "a" | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (QUESTION.test(line)) { cards.push({ q: line.replace(QUESTION, ""), a: "" }); field = "q"; continue; }
    if (ANSWER.test(line) && cards.length) { cards[cards.length - 1].a = line.replace(ANSWER, ""); field = "a"; continue; }
    if (field && line.trim() && cards.length) cards[cards.length - 1][field] += `\n${line}`;
  }
  return cards.filter((c) => c.q && c.a);
}

/** Splits off the closing 自测 section, which the app shows as cards so the answers start hidden. */
export function parseLesson(md: string): Lesson {
  const { meta, rest } = frontMatter(md);
  const heading = /^##\s*自测\s*$/m.exec(rest);
  const body = (heading ? rest.slice(0, heading.index) : rest).trim();
  const quiz = heading ? parseQuiz(rest.slice(heading.index + heading[0].length)) : [];
  return { title: meta.title ?? /^#\s+(.+)$/m.exec(rest)?.[1] ?? "", project: meta.project ?? "", mode: meta.mode ?? "", body, quiz };
}

/** The message that asks the primary for a lesson; src/study.ts parses it. Null when there is nothing to study. */
export function studyCommand(req: { topic: string; project: string; mode: string }): string | null {
  const topic = req.topic.trim(), project = req.project.trim().replace(/\s+/g, "");
  if (!topic && !project) return null;
  return ["/study", ...(req.mode !== "auto" ? [`mode=${req.mode}`] : []), ...(project ? [`project=${project}`] : []), ...(topic ? [topic] : [])].join(" ");
}

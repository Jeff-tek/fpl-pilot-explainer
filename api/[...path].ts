interface Res {
  status(code: number): Res;
  json(body: unknown): void;
}

export default function handler(_req: unknown, res: Res): void {
  res.status(200).json({ probe: 'node-style-ok' });
}

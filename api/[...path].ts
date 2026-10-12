export default function handler(): Response {
  return new Response(JSON.stringify({ probe: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

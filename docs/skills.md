# Writing a NyatBot skill

A skill is a JSON file in `skills/`. That's the whole extension surface: no SDK,
no class hierarchy, nothing to install. The bot loads it, validates its schema,
and from then on it can decide to call it as a tool.

This document is the walkthrough, including the failure modes the loader
deliberately refuses.

---

## The shape

```json
{
  "name": "IP_QUALITY",
  "description": "Check whether an IP address is a known proxy/VPN exit. Use when someone asks about an IP.",
  "parameters": {
    "ip": {
      "type": "string",
      "description": "IPv4 or IPv6 address",
      "required": true
    }
  },
  "trusted": true,
  "execute": {
    "type": "http",
    "method": "GET",
    "url": "https://ipquality.example/api/{{ip}}",
    "allowedHosts": ["ipquality.example"]
  }
}
```

| field | required | notes |
|---|---|---|
| `name` | yes | Must match `/^[A-Z0-9_]+$/`. Cannot shadow a built-in tool (`SEARCH`, `FETCH`, `IP_QUALITY`, `ADD_TIMER`, `LIST_TIMERS`, `DELETE_TIMER`, `BOT_KNOWLEDGE`). |
| `description` | yes | **This is the prompt.** Write it for the model, not for a human. Say *when* to use it, not just what it does. |
| `parameters` | no | Zod-validated before the model sees them. See [Parameters](#parameters). |
| `trusted` | no | Defaults to `false`. If `true` **and** `execute.type === "http"`, `allowedHosts` must be non-empty or the skill is refused at load time. |
| `execute` | yes | Discriminated union. See [Execution](#execution). |

---

## Parameters

```json
"parameters": {
  "city": {
    "type": "string",
    "description": "City name, in the language the user wrote it",
    "required": true
  },
  "days": {
    "type": "number",
    "description": "How many days ahead (1-7)",
    "required": false
  }
}
```

Supported types map onto zod primitives. Unknown fields in the *request* are
stripped by the schema, so a confused model can't smuggle extra arguments
through — the host sees exactly the validated shape.

`description` on a parameter is load-bearing. The model picks values from it.
`"ip": {"type":"string"}` gets you a model passing in hostnames; `"IPv4 or IPv6
address"` gets you an address.

---

## Execution

### `http`

The only enabled path. The URL and (optionally) the body support `{{param}}`
substitution:

```json
"execute": {
  "type": "http",
  "method": "GET",
  "url": "https://api.example.com/v1/weather?city={{city}}&days={{days}}",
  "allowedHosts": ["api.example.com"]
}
```

POST with a templated body:

```json
"execute": {
  "type": "http",
  "method": "POST",
  "url": "https://api.example.com/v1/translate",
  "headers": { "Content-Type": "application/json" },
  "body": "{\\"text\\": \\"{{text}}\\", \\"target\\": \\"{{target}}\"}",
  "allowedHosts": ["api.example.com"]
}
```

**Host allowlisting is the security boundary.** Before the request leaves the
host, the URL's host is checked against `allowedHosts`. Entries support a
leading wildcard (`*.example.com` matches `a.example.com` and `example.com`).

A skill that isn't `trusted` can still make HTTP calls — but the point of
`trusted` is to *force* you to declare the allowlist. An untrusted skill with a
user-controlled URL is how a tool becomes an open proxy; the loader makes you
be explicit about it.

### `script` — refused

```json
"execute": { "type": "script", "command": "./do-thing.sh", "args": [], "timeout": 10000 }
```

This loads, and is then **skipped with a warning**. Script execution is disabled
by design: a community-contributed skill directory should not be a
remote-code-execution surface. If you need computation, expose it as an HTTP
endpoint and point the skill at that.

You'll see this in the log:

```
Skill type "script" is disabled for security reasons, skipping
```

---

## What the loader refuses, and why

Each of these is a `logger.warn` and a skip — the rest of your skills still
load. None of them are silent.

| Refusal | Reason |
|---|---|
| name fails `/^[A-Z0-9_]+$/` | the name becomes a tool identifier; control characters in it become prompt-injection surface |
| name collides with a built-in | you'd be shadowing a core tool in a way that's invisible to the caller |
| `trusted` http skill with empty/missing `allowedHosts` | an allowlist you didn't write is not an allowlist |
| `execute.type === "script"` | no code execution from the skill directory, by design |
| JSON doesn't parse / schema fails | the skill is data; malformed data is a bug, and it should surface |

---

## Hot reload

`preloadSkills()` re-reads the directory. No restart. A skill you add while the
bot is running is available on the next turn.

---

## A complete worked example

`skills/GITHUB_REPO.json` — let the bot answer "what does repo X do":

```json
{
  "name": "GITHUB_REPO",
  "description": "Fetch a public GitHub repository's metadata (description, stars, language, last push). Use when someone mentions a repo in owner/name form or asks what a project is.",
  "parameters": {
    "repo": {
      "type": "string",
      "description": "Repository in owner/name form, e.g. ZYHUO/nyat-bot",
      "required": true
    }
  },
  "trusted": true,
  "execute": {
    "type": "http",
    "method": "GET",
    "url": "https://api.github.com/repos/{{repo}}",
    "allowedHosts": ["api.github.com"]
  }
}
```

Then in the group:

> someone: ZYHUO/nyat-bot 是个啥
>
> NyatBot: 一个 Telegram 群聊 agent…… 165k 行 TypeScript，MIT。它那个"沉默是一等公民"的卖点我看了，有点东西

---

## Where the code lives

| what | where |
|---|---|
| loader + all the refusals | [`src/pipeline/tools/skill-loader.ts`](../src/pipeline/tools/skill-loader.ts) |
| schema (zod) | same file, `skillSchema` |
| host allowlist matching | same file, `isHostAllowed` |
| built-in tool names that can't be shadowed | same file, `BUILTIN_TOOLS` |

If you add a new refusal condition, add a test that it refuses. The loader's
whole value is that it says no to things; a silent "yes" is the bug.

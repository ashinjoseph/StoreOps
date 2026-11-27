# Connect an assistant

How to let an AI assistant (Muse, later Claude) into the Operations app: it
can read a few things and, if you allow it, propose a few things. A proposal
changes nothing until a person confirms it on a screen. What it can and cannot
do is on the [Assistants](../components/assistants.md) page.

**This works only on the hosted app**, the one on the internet. An assistant
reaches the app from its provider's computers, so it cannot reach a copy
running on a home computer.

## 1. Open the door

Sign in as an admin. **More → Settings**, under *Assistants*, tap
**assistants_enabled** and choose **Yes**, then **Save**. Until you do, the
door answers nothing to anyone, with or without a key.

The two limits next to it, calls per minute (30) and proposals per day (200),
are per key. Leave them unless an assistant is being refused for going too
fast.

## 2. Make a key

**More → Assistants → Make a key.**

- **Person**: whose assistant it is. Everything the assistant does is recorded
  under that person and that key.
- **Label**: which assistant, for example *Priya's Muse*.
- **What it may do**: *Read only*, or *Read and propose*. Start with read only.
- **Personal details**: *No* unless the assistant will plan deliveries (no
  tool uses this yet).
- **Days until it expires**: 90 unless you have a reason.

Tap **Make the key**. The key is shown **once**. Copy it with **Copy the
key**, paste it straight into the assistant's own secure field for a key or
token, and tap **Done**. Never paste it into a chat, an email or a document.
If it is lost, withdraw it and make a new one.

## 3. Give the assistant two things

| What the assistant asks for | What to give it |
|---|---|
| Server address (URL) | the app's address followed by `/mcp`, for example `https://ops.example.com/mcp` (the sheet shows the exact one) |
| Kind of connection, if asked | Streamable HTTP (sometimes called "HTTP" or "remote") |
| Authentication | a header: name `Authorization`, value `Bearer ` followed by the key (one space after `Bearer`) |

If the assistant offers a sign-in (OAuth) instead of a header, this door does
not have one yet: use the header.

## 4. Check it works

Ask the assistant to use the **whoami** tool. It should answer with the key's
label, your person's name, *read only* or *read and propose*, and the day the
key expires. On the Assistants screen the key now shows *last used* and *1
call today*.

If it does not connect:

- the door is closed (step 1), or
- the key was mistyped, has expired or was withdrawn (make a new one), or
- the person it belongs to is no longer active, or
- the assistant is being run from a web page that sends an `Origin` header,
  which the door refuses on purpose.

The app never says which of these it was, to the assistant or to anyone else;
the reason is kept in the app's record of calls.

## 5. Withdraw a key

**More → Assistants**, **Withdraw** on the key, give a reason. It stops
working at once, on the assistant's next call. Withdraw a key when a phone or
laptop with the assistant is lost, when the person leaves, or when the
assistant is no longer used. Deactivating a person on the staff list stops all
their keys too.

To close the door for every assistant at once, set **assistants_enabled** back
to **No**.

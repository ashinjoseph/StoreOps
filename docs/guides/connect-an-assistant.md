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

## 5. What to ask it to do

With a key that may **read**, it can see the receipts waiting to be read and be
shown each one. With a key that may **read and propose**, it can also hand
receipts over. Two requests, in plain words:

- *"Look at the receipts waiting in the Operations app and tell me what each
  one is."* It lists what is waiting (oldest first) and is shown each photo or
  PDF as it was kept. Nothing changes in the app.
- *"Find the supplier invoices in my inbox from this week and hand each one
  over to the Operations app's receipts. Skip any it already has."* For each
  email it first asks whether that email was handed over already, then asks for
  a one-time upload address and sends the attached file there. This needs an
  assistant that can send a file (one with a computer of its own, or a
  scheduled task), and the mailbox connected to it.

What you then see: under **More → Receipts → Waiting**, each original it handed
over says *added by Priya Nair's assistant (Priya's Muse)* (your name and the
key's label), and an emailed one also shows who sent it and when. It is kept
exactly as sent, like a photo you took; nothing is read from it or confirmed
yet. On the **Assistants** screen the key's *calls today* go up, and each upload
address it asked for counts as one proposal. The assistant can ask
`my_proposals` whether each file was kept, was already on file, or was refused
(and why).

For a **daily scan of the mailbox** that does this for every invoice email,
remembers which emails are done (including the ones with nothing to file) and
prints an invoice that is only the email's own text, give the assistant the
instructions in [Scan the mailbox for invoices](email-invoice-scan.md).

## 6. Withdraw a key

**More → Assistants**, **Withdraw** on the key, give a reason. It stops
working at once, on the assistant's next call. Withdraw a key when a phone or
laptop with the assistant is lost, when the person leaves, or when the
assistant is no longer used. Deactivating a person on the staff list stops all
their keys too.

To close the door for every assistant at once, set **assistants_enabled** back
to **No**.

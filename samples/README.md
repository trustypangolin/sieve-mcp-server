# Sample Sieve rules

Example scripts to copy from. They use standard extensions ([RFC 5228](https://www.rfc-editor.org/rfc/rfc5228) plus the RFCs for each extension). Before using one, check that your server supports every extension in its `require` line with `node dist/setup.js test <account>` or the `sieve_get_capabilities` tool.

| File | Shows |
|---|---|
| `01-file-by-sender.sieve` | `fileinto` by sender address, domain, subject |
| `02-mailing-lists.sieve` | One folder per mailing list from `List-Id`, using `variables` |
| `03-spam-to-junk.sieve` | Moving spam-tagged mail; numeric score comparison |
| `04-vacation.sieve` | Out-of-office reply limited to a date range |
| `05-flags.sieve` | Flag or mark mail as read on arrival (`imap4flags`) |
| `06-plus-addressing.sieve` | `me+tag@` → folder per tag (`subaddress`) |
| `07-attachments-and-size.sieve` | Size limits and attachment file names (`mime`, `foreverypart`) |
| `08-complete-example.sieve` | Combines the above into one ordered script |

## Things to know

- **Only one script is active.** The server runs only the active script, so these samples are pieces to combine into a single script, not files to upload side by side.
- **Order matters.** Rules run from top to bottom. `stop;` ends processing. Without it, later rules still run, and the message can end up filed in more than one place.
- **Implicit keep.** If no rule files, discards or redirects a message, it is delivered to INBOX.
- **Folder names** must match the server's folders exactly, including the hierarchy separator (`/` or `.`). `:create` creates a missing folder, and needs the `mailbox` extension.

## Trying a sample

```bash
node dist/setup.js check samples/02-mailing-lists.sieve           # server-side syntax check only
cp samples/08-complete-example.sieve "local-rules/<account>/My Rules.sieve"
# edit it, then:
node dist/setup.js push "local-rules/<account>/My Rules.sieve"    # diff + confirm; not activated
```

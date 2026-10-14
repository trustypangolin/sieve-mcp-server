# A complete script in the order a real one usually takes:
# 1. junk first, 2. specific senders, 3. lists and newsletters, 4. everything else stays in INBOX.
# Only one script is active at a time, so the rules from the other samples get combined here.
# Every action needs its extension in the require line.

require ["fileinto", "mailbox", "imap4flags", "variables"];

# --- 1. Junk ------------------------------------------------------------------
if header :is "x-spam" "yes" {
    fileinto :create "Junk";
    stop;
}

# --- 2. People and senders ----------------------------------------------------
if address :is "from" "boss@work.example" {
    addflag "\\Flagged";
    # no stop: stays in INBOX, flagged
}

if address :domain :is "from" "mybank.example" {
    fileinto :create "Finance";
    stop;
}

# --- 3. Lists and newsletters -------------------------------------------------
if header :matches "list-id" "*<*.*>*" {
    set :lower "list" "${2}";
    fileinto :create "Lists/${list}";
    stop;
}

if exists "list-unsubscribe" {
    fileinto :create "Newsletters";
    stop;
}

# --- 4. Everything else -------------------------------------------------------
# Falls through to INBOX (implicit keep).

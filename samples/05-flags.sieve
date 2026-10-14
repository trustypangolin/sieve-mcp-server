# Flag or mark mail as read when it arrives, without moving it (imap4flags).

require ["imap4flags", "fileinto", "mailbox"];

# Star mail from important people
if address :is "from" ["boss@work.example", "partner@example.com"] {
    addflag "\\Flagged";
}

# Notifications you only want to keep for reference: file them and mark them read
if address :is "from" "noreply@notifications.example" {
    addflag "\\Seen";
    fileinto :create "Notifications";
    stop;
}

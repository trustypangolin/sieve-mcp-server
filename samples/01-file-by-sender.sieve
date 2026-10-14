# File mail into folders by sender or subject.
# Folder names must match your server's folders exactly; the separator ("/" or ".")
# depends on the server. The imap MCP's imap_list_folders shows the real names.
# ":create" (from the "mailbox" extension) creates the folder if it is missing.

require ["fileinto", "mailbox"];

# One sender
if address :is "from" "statements@mybank.example" {
    fileinto :create "Finance";
    stop;
}

# Any address at a domain
if address :domain :is "from" ["github.com", "gitlab.com"] {
    fileinto :create "Dev/Notifications";
    stop;
}

# Subject keywords (case-insensitive by default)
if header :contains "subject" ["invoice", "receipt", "order confirmation"] {
    fileinto :create "Receipts";
    stop;
}

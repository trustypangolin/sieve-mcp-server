# Move mail the server's spam filter has tagged into Junk.
# Header names vary by provider; check a spam message's raw headers
# (imap_get_email with headers) and adjust.

require ["fileinto", "mailbox", "relational", "comparator-i;ascii-numeric"];

# Rspamd / SpamAssassin style yes/no flags
if anyof (header :is "x-spam" "yes",
          header :is "x-spam-flag" "YES") {
    fileinto :create "Junk";
    stop;
}

# Numeric score threshold, e.g. "X-Spam-Score: 7.2" (compares the integer part)
if header :value "ge" :comparator "i;ascii-numeric" "x-spam-score" "6" {
    fileinto :create "Junk";
    stop;
}

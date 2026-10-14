# Rules based on message size or attachments (the "mime" and "foreverypart" extensions).

require ["fileinto", "mailbox", "mime", "foreverypart", "imap4flags"];

# Big messages
if size :over 15M {
    fileinto :create "Large";
    stop;
}

# Invoices sent as PDF attachments
foreverypart {
    if header :mime :param "filename" :matches "content-disposition" "*.pdf" {
        if header :contains "subject" "invoice" {
            addflag "\\Flagged";
            fileinto :create "Receipts";
            stop;
        }
    }
}

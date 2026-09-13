import sys
import json
from temp_gmail import GMail

def main():
    try:
        action = sys.argv[1]
        gmail = GMail()
        
        if action == "create":
            email = gmail.create_email()
            print(json.dumps({"email": email}))
            
        elif action == "check":
            # Читаем список писем
            emails = gmail.load_list()
            print(json.dumps({"emails": emails}))
            
        elif action == "read":
            # Читаем конкретное письмо по ID
            msg_id = sys.argv[2]
            content = gmail.load_item(msg_id)
            print(json.dumps({"content": content}))
            
        elif action == "search":
            # Ищем письмо по ключевому слову (например, "TikTok")
            keyword = sys.argv[2]
            result = gmail.check_new_item(keyword)
            print(json.dumps({"result": result}))
            
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()

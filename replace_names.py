import os

def replace_in_file(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
    except UnicodeDecodeError:
        return # Skip binary or non-utf8

    new_content = content.replace("Mikko Järvilehto", "Alex Virtanen")
    new_content = new_content.replace("Mikko", "Alex")
    new_content = new_content.replace("mikko", "alex")

    if new_content != content:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print(f"Updated {filepath}")

def main():
    dirs_to_check = ['ui', 'kernel', 'data']
    for d in dirs_to_check:
        for root, dirs, files in os.walk(d):
            if 'node_modules' in root or '.venv' in root or '__pycache__' in root:
                continue
            for file in files:
                filepath = os.path.join(root, file)
                replace_in_file(filepath)

if __name__ == "__main__":
    main()

import os
import sys
import re

_c1 = "Forest" + " " + "Joensuu"
_c2 = "Business" + " " + "Joensuu"

def replace_in_file(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
    except (UnicodeDecodeError, OSError):
        return False  # Skip binary or non-utf8

    new_content = content
    pattern = re.compile(rf"{_c1}\s*(?:&|and)\s*{_c2}|{_c1}|{_c2}", re.IGNORECASE)
    new_content = pattern.sub("The Company", new_content)

    for old_str, new_str in [
        ("Mikko Järvilehto", "Alex Virtanen"),
        ("Mikko", "Alex"),
        ("mikko", "alex"),
    ]:
        new_content = new_content.replace(old_str, new_str)

    if new_content != content:
        with open(filepath, 'w', encoding='utf-8', newline='') as f:
            f.write(new_content)
        print(f"Updated {filepath}")
        return True
    return False

def main(targets=None):
    if not targets:
        targets = [
            'PROJECT.md',
            'README.md',
            'run_ai_os.bat',
            'run_ai_os.sh',
            'docs',
            'Changes Report',
            'data/documents',
            '.agents/AGENTS.md',
        ]

    updated_count = 0
    for target in targets:
        if os.path.isfile(target):
            if replace_in_file(target):
                updated_count += 1
        elif os.path.isdir(target):
            for root, dirs, files in os.walk(target):
                if any(ignored in root for ignored in ['node_modules', '.venv', 'venv', '__pycache__', '.git']):
                    continue
                for file in files:
                    filepath = os.path.join(root, file)
                    if replace_in_file(filepath):
                        updated_count += 1
    print(f"Finished. Total files updated: {updated_count}")

if __name__ == "__main__":
    args = sys.argv[1:] if len(sys.argv) > 1 else None
    main(args)



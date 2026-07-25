@echo off
echo Creating Python Virtual Environment...
python -m venv venv
if %errorlevel% neq 0 (
    echo Failed to create venv
    exit /b %errorlevel%
)

echo Activating venv...
call venv\Scripts\activate.bat

echo Upgrading pip...
python -m pip install --upgrade pip

echo Installing PyTorch with CUDA 12.1 support...
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

echo Installing AI Service requirements...
pip install -r requirements.txt

echo Setup Complete! You can now run python main.py

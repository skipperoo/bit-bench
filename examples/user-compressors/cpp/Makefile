CXX ?= g++
CXXFLAGS ?= -O3 -march=native -std=c++17 -Wall -Wextra

codec: src/main.cpp
	$(CXX) $(CXXFLAGS) -o codec src/main.cpp

clean:
	rm -f codec

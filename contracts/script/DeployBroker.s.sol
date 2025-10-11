// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "../src/UnicitySwapBroker.sol";

/**
 * @title DeployBroker
 * @notice Deployment script for UnicitySwapBroker contract
 * @dev Usage:
 *      Local/Testnet: forge script script/DeployBroker.s.sol --rpc-url <RPC_URL> --broadcast
 *      Mainnet: forge script script/DeployBroker.s.sol --rpc-url <RPC_URL> --broadcast --verify
 *
 *      Required environment variables:
 *      - PRIVATE_KEY: Deployer private key
 *      - OPERATOR_ADDRESS: Address authorized to execute swaps/reverts
 */
contract DeployBroker is Script {
    function run() external {
        // Load environment variables
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address operator = vm.envAddress("OPERATOR_ADDRESS");

        console.log("=== UnicitySwapBroker Deployment ===");
        console.log("Deployer:", vm.addr(deployerPrivateKey));
        console.log("Operator:", operator);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy broker contract
        UnicitySwapBroker broker = new UnicitySwapBroker(operator);

        vm.stopBroadcast();

        console.log("\n=== Deployment Successful ===");
        console.log("UnicitySwapBroker deployed at:", address(broker));
        console.log("Owner:", broker.owner());
        console.log("Operator:", broker.operator());

        console.log("\n=== Verification Command ===");
        console.log(
            string.concat(
                "forge verify-contract ",
                vm.toString(address(broker)),
                " src/UnicitySwapBroker.sol:UnicitySwapBroker ",
                "--constructor-args $(cast abi-encode 'constructor(address)' ",
                vm.toString(operator),
                ") --chain-id ",
                vm.toString(block.chainid)
            )
        );

        console.log("\n=== Integration Notes ===");
        console.log("1. For native swaps: Call swapNative() with msg.value");
        console.log("2. For ERC20 swaps: Escrow must approve broker BEFORE calling swapERC20()");
        console.log("3. Each dealId can only be used once (swap OR revert, not both)");
        console.log("4. Only operator can execute swap/revert functions");
        console.log("5. Owner can update operator via setOperator()");
    }
}

/**
 * @title DeployBrokerTestnet
 * @notice Testnet deployment with additional setup
 */
contract DeployBrokerTestnet is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address operator = vm.envAddress("OPERATOR_ADDRESS");

        console.log("=== UnicitySwapBroker Testnet Deployment ===");
        console.log("Deployer:", vm.addr(deployerPrivateKey));
        console.log("Operator:", operator);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy broker
        UnicitySwapBroker broker = new UnicitySwapBroker(operator);

        // Optional: Deploy mock ERC20 for testing
        MockERC20 testToken = new MockERC20("Test Token", "TEST", 18);
        testToken.mint(vm.addr(deployerPrivateKey), 1000000 ether);

        vm.stopBroadcast();

        console.log("\n=== Deployment Successful ===");
        console.log("UnicitySwapBroker:", address(broker));
        console.log("Test Token:", address(testToken));
        console.log("Owner:", broker.owner());
        console.log("Operator:", broker.operator());

        console.log("\n=== Test Token Setup ===");
        console.log("Token Name:", testToken.name());
        console.log("Token Symbol:", testToken.symbol());
        console.log("Initial Supply:", testToken.totalSupply() / 1e18, "tokens");
    }
}

/**
 * @title MockERC20
 * @notice Simple ERC20 for testnet deployments
 */
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
